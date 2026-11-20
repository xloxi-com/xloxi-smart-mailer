/**
 * Durable customer / subscriber sync job orchestration.
 */
import type { SyncJob } from "@prisma/client";
import { SyncJobStatus, SyncJobType } from "../lib/prisma.server";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  sanitizeSyncPartialErrors,
  toMerchantSafeError,
} from "../lib/safe-error.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { ensureShop } from "../services/shop.server";
import {
  getSubscriberCounts,
  runCustomerSyncTick,
  type CustomerSyncStats,
} from "../services/customer-sync.server";

export type CustomerSyncJobStats = CustomerSyncStats & {
  ticks: number;
  startedAt: string;
  fullReconcile?: boolean;
};

function asStats(value: unknown): Partial<CustomerSyncJobStats> {
  if (!value || typeof value !== "object") return {};
  return value as Partial<CustomerSyncJobStats>;
}

export async function enqueueCustomerSyncJob(options: {
  shopDomain: string;
  fullReconcile?: boolean;
}): Promise<SyncJob> {
  const shop = await ensureShop(options.shopDomain);
  const idempotencyKey = `customer-sync:${shop.id}:${Date.now()}`;

  await prisma.syncJob.updateMany({
    where: {
      shopId: shop.id,
      type: SyncJobType.CUSTOMERS,
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
    },
    data: { status: SyncJobStatus.CANCELLED, completedAt: new Date() },
  });

  return prisma.syncJob.create({
    data: {
      shopId: shop.id,
      type: SyncJobType.CUSTOMERS,
      status: SyncJobStatus.PENDING,
      idempotencyKey,
      runAt: new Date(),
      stats: {
        ticks: 0,
        startedAt: new Date().toISOString(),
        fullReconcile: options.fullReconcile !== false,
        seenGids: [],
      },
    },
  });
}

export async function processCustomerSyncJobTick(options: {
  shopDomain: string;
  client: AdminGraphqlClient;
  jobId?: string;
}): Promise<{
  job: SyncJob;
  stats: CustomerSyncStats;
  counts: Awaited<ReturnType<typeof getSubscriberCounts>>;
}> {
  const shop = await ensureShop(options.shopDomain);
  const intervalDays = shop.automationSettings?.intervalDays ?? 3;

  let job =
    (options.jobId
      ? await prisma.syncJob.findFirst({
          where: { id: options.jobId, shopId: shop.id },
        })
      : null) ??
    (await prisma.syncJob.findFirst({
      where: {
        shopId: shop.id,
        type: SyncJobType.CUSTOMERS,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
      },
      orderBy: { createdAt: "desc" },
    }));

  if (!job) {
    job = await enqueueCustomerSyncJob({
      shopDomain: options.shopDomain,
      fullReconcile: true,
    });
  }

  const prev = asStats(job.stats);
  const leaseOwner = `customer-sync:${process.pid}`;

  job = await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: SyncJobStatus.RUNNING,
      startedAt: job.startedAt ?? new Date(),
      attemptCount: { increment: 1 },
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });

  const tickStats = await runCustomerSyncTick(options.client, {
    shopDomain: options.shopDomain,
    shopId: shop.id,
    intervalDays,
    cursor: job.cursor,
    fullReconcile: prev.fullReconcile !== false,
    seenGids: Array.isArray(prev.seenGids) ? (prev.seenGids as string[]) : [],
  });

  const mergedSeen = [
    ...new Set([
      ...(Array.isArray(prev.seenGids) ? (prev.seenGids as string[]) : []),
      ...tickStats.seenGids,
    ]),
  ];

  const nextStats: CustomerSyncJobStats = {
    ...tickStats,
    seenGids: mergedSeen,
    ticks: (typeof prev.ticks === "number" ? prev.ticks : 0) + 1,
    startedAt:
      typeof prev.startedAt === "string"
        ? prev.startedAt
        : new Date().toISOString(),
    processed:
      (typeof prev.processed === "number" ? prev.processed : 0) +
      tickStats.processed,
    upserted:
      (typeof prev.upserted === "number" ? prev.upserted : 0) +
      tickStats.upserted,
    eligible:
      (typeof prev.eligible === "number" ? prev.eligible : 0) +
      tickStats.eligible,
    skipped:
      (typeof prev.skipped === "number" ? prev.skipped : 0) + tickStats.skipped,
    softDeleted:
      (typeof prev.softDeleted === "number" ? prev.softDeleted : 0) +
      tickStats.softDeleted,
    errors:
      (typeof prev.errors === "number" ? prev.errors : 0) + tickStats.errors,
    partialErrors: [
      ...(Array.isArray(prev.partialErrors)
        ? (prev.partialErrors as string[])
        : []),
      ...tickStats.partialErrors,
    ].slice(-50),
    fullReconcile: prev.fullReconcile !== false,
  };

  const done = !tickStats.hasMore;
  const totalErrors = nextStats.errors;
  const finalStatus = !done
    ? SyncJobStatus.RUNNING
    : totalErrors > 0
      ? SyncJobStatus.FAILED
      : SyncJobStatus.SUCCEEDED;
  const safePartials = sanitizeSyncPartialErrors(
    Array.isArray(nextStats.partialErrors)
      ? (nextStats.partialErrors as string[])
      : [],
  );

  job = await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: finalStatus,
      cursor: tickStats.cursor,
      completedAt: done ? new Date() : null,
      leaseOwner: done ? null : leaseOwner,
      leaseExpiresAt: done ? null : new Date(Date.now() + 5 * 60_000),
      stats: { ...nextStats, partialErrors: safePartials },
      lastError:
        totalErrors > 0
          ? toMerchantSafeError(
              safePartials.slice(-1)[0] ?? "sync_errors",
              "Customer synchronization failed",
            )
          : null,
    },
  });

  if (done) {
    await prisma.auditLog.create({
      data: {
        shopId: shop.id,
        action: "SYNC",
        entityType: "Subscriber",
        entityId: job.id,
        actorType: "system",
        metadata: {
          status: finalStatus,
          processed: nextStats.processed,
          eligible: nextStats.eligible,
          softDeleted: nextStats.softDeleted,
          errors: totalErrors,
        },
      },
    });
  }

  logger.info("customer_sync_tick", {
    shop: options.shopDomain,
    jobId: job.id,
    phase: tickStats.phase,
    hasMore: tickStats.hasMore,
    processed: tickStats.processed,
  });

  const counts = await getSubscriberCounts(shop.id);
  return { job, stats: tickStats, counts };
}
