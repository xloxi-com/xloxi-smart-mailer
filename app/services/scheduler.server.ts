/**
 * Optional app-managed scheduler for large subscriber lists.
 *
 * Instead of sending email, tags due subscribers with xloxi-request (max 100
 * per run) so Shopify Flow / the customers/update webhook drives selection.
 * Requires AutomationSettings.appSchedulerEnabled = true.
 */
import type { Shop, AutomationSettings } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { MarketingConsentState } from "../lib/prisma.server";
import {
  createWorkerId,
  DURABLE_LOCKS,
  emptyWorkerMetrics,
  finishWorkerHeartbeat,
  pulseWorkerHeartbeat,
  releaseDurableLock,
  startWorkerHeartbeat,
  tryDurableLock,
  type WorkerMetrics,
} from "./job-queue.server";
import { tagDueSubscribersWithRequest } from "./flow-selection.server";

export const DEFAULT_INTERVAL_HOURS = 72;
export const SCHEDULER_TICK_MINUTES = 5;

export type SchedulerShopResult = {
  shopId: string;
  shopDomain: string;
  dueFound: number;
  reserved: number;
  skippedNoProducts: number;
  skippedIneligible: number;
  skippedActiveJob: number;
  skippedLimit: number;
  errors: number;
};

export type SchedulerRunResult = {
  locked: boolean;
  shops: SchedulerShopResult[];
  metrics: WorkerMetrics;
  workerId: string;
};

function intervalMs(intervalDays: number): number {
  return Math.max(intervalDays, 1) * 24 * 60 * 60 * 1000;
}

export function buildScheduleIdempotencyKey(
  subscriberId: string,
  nextEmailAt: Date,
): string {
  return `flow-request:${subscriberId}:${nextEmailAt.toISOString()}`;
}

type ShopRow = Shop & { automationSettings: AutomationSettings | null };

async function listSchedulableShops(shopId?: string): Promise<ShopRow[]> {
  return prisma.shop.findMany({
    where: {
      ...(shopId ? { id: shopId } : {}),
      uninstalledAt: null,
      automationSettings: {
        is: {
          automationEnabled: true,
          appSchedulerEnabled: true,
        },
      },
    },
    include: { automationSettings: true },
  });
}

async function scheduleShop(options: {
  shop: ShopRow;
  now: Date;
}): Promise<SchedulerShopResult> {
  const settings = options.shop.automationSettings!;
  const result: SchedulerShopResult = {
    shopId: options.shop.id,
    shopDomain: options.shop.shopDomain,
    dueFound: 0,
    reserved: 0,
    skippedNoProducts: 0,
    skippedIneligible: 0,
    skippedActiveJob: 0,
    skippedLimit: 0,
    errors: 0,
  };

  const limit = Math.min(100, Math.max(1, settings.maxEmailsPerRun ?? 50));

  const dueCount = await prisma.subscriber.count({
    where: {
      shopId: options.shop.id,
      eligible: true,
      isSuppressed: false,
      paused: false,
      deletedAt: null,
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      OR: [{ nextEmailAt: null }, { nextEmailAt: { lte: options.now } }],
      pendingBatchId: null,
    },
  });
  result.dueFound = dueCount;

  try {
    // Lazy import — avoids loading shopify.server during unit/integration collect.
    const { getOfflineAdmin } = await import("../shopify/offline-admin.server");
    const { admin } = await getOfflineAdmin(options.shop.shopDomain);
    const tagged = await tagDueSubscribersWithRequest({
      client: admin,
      shopDomain: options.shop.shopDomain,
      shopId: options.shop.id,
      limit,
    });
    result.reserved = tagged.tagged;
    result.skippedIneligible = tagged.skipped;
  } catch (error) {
    result.errors += 1;
    logger.error("scheduler_tag_failed", {
      shop: options.shop.shopDomain,
      name: error instanceof Error ? error.name : "unknown",
    });
  }

  return result;
}

/** @deprecated name kept for worker routes — now tags Flow requests only. */
export async function runEmailScheduler(options?: {
  now?: Date;
  shopId?: string;
  workerId?: string;
}): Promise<SchedulerRunResult> {
  const workerId = options?.workerId ?? createWorkerId("scheduler");
  const now = options?.now ?? new Date();
  const metrics = emptyWorkerMetrics();

  const locked = await tryDurableLock({
    lockId: DURABLE_LOCKS.scheduler,
    owner: workerId,
    ttlMs: 4 * 60 * 1000,
  });
  if (!locked) {
    logger.warn("scheduler_overlap_skipped", { workerId });
    return { locked: false, shops: [], metrics, workerId };
  }

  const heartbeatId = await startWorkerHeartbeat({
    workerId,
    workerType: "scheduler",
    metrics,
  });

  const shops: SchedulerShopResult[] = [];

  try {
    const targets = await listSchedulableShops(options?.shopId);
    for (const shop of targets) {
      const shopResult = await scheduleShop({ shop, now });
      shops.push(shopResult);
      metrics.processed += shopResult.dueFound;
      metrics.accepted += shopResult.reserved;
      metrics.skipped +=
        shopResult.skippedNoProducts +
        shopResult.skippedIneligible +
        shopResult.skippedActiveJob +
        shopResult.skippedLimit;
      metrics.errors += shopResult.errors;
      await pulseWorkerHeartbeat(heartbeatId, metrics);
    }

    await finishWorkerHeartbeat(heartbeatId, metrics, "succeeded");
    logger.info("scheduler_run_complete", {
      workerId,
      shopCount: shops.length,
      tagged: metrics.accepted,
      mode: "flow_request_tags",
    });
  } catch (error) {
    metrics.errors += 1;
    const message = error instanceof Error ? error.message : "scheduler_failed";
    await finishWorkerHeartbeat(heartbeatId, metrics, "failed", message);
    logger.error("scheduler_run_failed", {
      workerId,
      name: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  } finally {
    await releaseDurableLock({
      lockId: DURABLE_LOCKS.scheduler,
      owner: workerId,
    });
  }

  return { locked: true, shops, metrics, workerId };
}

export { intervalMs };
