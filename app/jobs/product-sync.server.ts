/**
 * Durable product sync job orchestration (SyncJob rows).
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
import { PRODUCT_SYNC_REQUEST_BUDGET_MS } from "../services/shopify-graphql.server";
import {
  getCatalogSyncProgress,
  runProductSyncTick,
  type ProductSyncStats,
} from "../services/product-sync.server";

export type ProductSyncJobStats = ProductSyncStats & {
  ticks: number;
  startedAt: string;
  fullReconcile?: boolean;
  incrementalUpdatedAt?: string | null;
};

function asStats(value: unknown): Partial<ProductSyncJobStats> {
  if (!value || typeof value !== "object") return {};
  return value as Partial<ProductSyncJobStats>;
}

export async function enqueueProductSyncJob(options: {
  shopDomain: string;
  type?: SyncJobType;
  fullReconcile?: boolean;
  incrementalUpdatedAt?: Date | null;
}): Promise<SyncJob> {
  const shop = await ensureShop(options.shopDomain);
  const type = options.type ?? SyncJobType.PRODUCTS;
  const idempotencyKey = `product-sync:${shop.id}:${Date.now()}`;

  // Cancel other running product syncs for this shop to prevent overlap.
  await prisma.syncJob.updateMany({
    where: {
      shopId: shop.id,
      type: { in: [SyncJobType.PRODUCTS, SyncJobType.FULL] },
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
    },
    data: { status: SyncJobStatus.CANCELLED, completedAt: new Date() },
  });

  return prisma.syncJob.create({
    data: {
      shopId: shop.id,
      type,
      status: SyncJobStatus.PENDING,
      idempotencyKey,
      runAt: new Date(),
      stats: {
        ticks: 0,
        startedAt: new Date().toISOString(),
        fullReconcile: options.fullReconcile !== false,
        incrementalUpdatedAt:
          options.incrementalUpdatedAt?.toISOString() ?? null,
        seenGids: [],
      },
    },
  });
}

/**
 * Process one tick of the active product sync job for a shop.
 * Safe to call from Sync Now action or a scheduler.
 */
export async function processProductSyncJobTick(options: {
  shopDomain: string;
  client: AdminGraphqlClient;
  jobId?: string;
}): Promise<{
  job: SyncJob;
  stats: ProductSyncStats;
  progress: Awaited<ReturnType<typeof getCatalogSyncProgress>>;
}> {
  const shop = await ensureShop(options.shopDomain);
  const inStockOnly = shop.automationSettings?.inStockOnly !== false;

  let job =
    (options.jobId
      ? await prisma.syncJob.findFirst({
          where: { id: options.jobId, shopId: shop.id },
        })
      : null) ??
    (await prisma.syncJob.findFirst({
      where: {
        shopId: shop.id,
        type: { in: [SyncJobType.PRODUCTS, SyncJobType.FULL] },
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
      },
      orderBy: { createdAt: "desc" },
    }));

  if (!job) {
    job = await enqueueProductSyncJob({
      shopDomain: options.shopDomain,
      fullReconcile: true,
    });
  }

  if (job.status === SyncJobStatus.CANCELLED) {
    throw new Error("Sync job was cancelled");
  }

  const prev = asStats(job.stats);
  const leaseOwner = `sync-tick:${process.pid}`;

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

  const incrementalUpdatedAt =
    typeof prev.incrementalUpdatedAt === "string"
      ? prev.incrementalUpdatedAt
      : null;

  const shopifyQuery = incrementalUpdatedAt
    ? `updated_at:>'${incrementalUpdatedAt}'`
    : null;

  const tickStats = await runProductSyncTick(options.client, {
    shopDomain: options.shopDomain,
    shopId: shop.id,
    inStockOnly,
    cursor: job.cursor,
    bulkOperationId:
      typeof prev.bulkOperationId === "string" ? prev.bulkOperationId : null,
    fullReconcile: prev.fullReconcile !== false && !shopifyQuery,
    shopifyQuery,
    seenGids: Array.isArray(prev.seenGids)
      ? (prev.seenGids as string[])
      : [],
    ...(typeof prev.shopifyProductCount === "number"
      ? { knownCount: prev.shopifyProductCount }
      : {}),
  });

  // A newer Sync products click may have cancelled this job while the tick ran.
  const stillActive = await prisma.syncJob.findFirst({
    where: {
      id: job.id,
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
    },
  });
  if (!stillActive) {
    return {
      job: await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }),
      stats: tickStats,
      progress: await getCatalogSyncProgress(shop.id),
    };
  }

  const mergedSeen = [
    ...new Set([
      ...(Array.isArray(prev.seenGids) ? (prev.seenGids as string[]) : []),
      ...tickStats.seenGids,
    ]),
  ];

  const nextStats: ProductSyncJobStats = {
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
    softDeleted:
      (typeof prev.softDeleted === "number" ? prev.softDeleted : 0) +
      tickStats.softDeleted,
    eligible:
      (typeof prev.eligible === "number" ? prev.eligible : 0) +
      tickStats.eligible,
    errors:
      (typeof prev.errors === "number" ? prev.errors : 0) + tickStats.errors,
    partialErrors: [
      ...(Array.isArray(prev.partialErrors)
        ? (prev.partialErrors as string[])
        : []),
      ...tickStats.partialErrors,
    ].slice(-50),
  };

  const done = !tickStats.hasMore;
  const totalErrors = nextStats.errors;
  const failedCompletely =
    done &&
    (totalErrors > 0 ||
      tickStats.phase === "bulk_failed" ||
      (nextStats.processed === 0 && totalErrors > 0));
  // Partial success still completes, but any errors must not report SUCCEEDED.
  const finalStatus = !done
    ? SyncJobStatus.RUNNING
    : failedCompletely || totalErrors > 0
      ? SyncJobStatus.FAILED
      : SyncJobStatus.SUCCEEDED;

  const safePartials = sanitizeSyncPartialErrors(
    Array.isArray(nextStats.partialErrors)
      ? (nextStats.partialErrors as string[])
      : [],
  );

  const updated = await prisma.syncJob.updateMany({
    where: {
      id: job.id,
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
    },
    data: {
      status: finalStatus,
      cursor: tickStats.cursor,
      completedAt: done ? new Date() : null,
      leaseOwner: done ? null : leaseOwner,
      leaseExpiresAt: done ? null : new Date(Date.now() + 5 * 60_000),
      stats: {
        ...nextStats,
        partialErrors: safePartials,
        bulkOperationId: tickStats.bulkOperationId,
        fullReconcile: prev.fullReconcile !== false,
        incrementalUpdatedAt,
      },
      lastError:
        totalErrors > 0
          ? toMerchantSafeError(
              safePartials.slice(-1)[0] ?? "sync_errors",
              "Product synchronization failed",
            )
          : null,
    },
  });

  job = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
  if (updated.count === 0) {
    return {
      job,
      stats: tickStats,
      progress: await getCatalogSyncProgress(shop.id),
    };
  }

  if (done && finalStatus === SyncJobStatus.SUCCEEDED) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        shopId: shop.id,
        action: "SYNC",
        entityType: "Product",
        entityId: job.id,
        actorType: "system",
        metadata: {
          processed: nextStats.processed,
          eligible: nextStats.eligible,
          softDeleted: nextStats.softDeleted,
          mode: tickStats.mode,
        },
      },
    });
  } else if (done && finalStatus === SyncJobStatus.FAILED) {
    await prisma.auditLog.create({
      data: {
        shopId: shop.id,
        action: "SYNC",
        entityType: "Product",
        entityId: job.id,
        actorType: "system",
        metadata: {
          status: "FAILED",
          processed: nextStats.processed,
          errors: totalErrors,
          mode: tickStats.mode,
        },
      },
    });
  }

  logger.info("product_sync_tick", {
    shop: options.shopDomain,
    jobId: job.id,
    phase: tickStats.phase,
    hasMore: tickStats.hasMore,
    processed: tickStats.processed,
  });

  const progress = await getCatalogSyncProgress(shop.id);
  return { job, stats: tickStats, progress };
}

export async function getProductSyncStatus(shopDomain: string) {
  const shop = await ensureShop(shopDomain);
  const progress = await getCatalogSyncProgress(shop.id);
  return {
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    lastSyncAt: shop.lastSyncAt,
    inStockOnly: shop.automationSettings?.inStockOnly !== false,
    ...progress,
  };
}

/** Cancel RUNNING/PENDING product syncs older than `staleAfterMs` (default 2m). */
export async function cancelStaleProductSyncJobs(
  shopDomain: string,
  staleAfterMs = 2 * 60_000,
): Promise<number> {
  const shop = await ensureShop(shopDomain);
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await prisma.syncJob.updateMany({
    where: {
      shopId: shop.id,
      type: { in: [SyncJobType.PRODUCTS, SyncJobType.FULL] },
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: SyncJobStatus.CANCELLED,
      completedAt: new Date(),
      lastError: "Sync timed out — click Sync products to retry",
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  return result.count;
}

/**
 * Run as many ticks as fit in the request budget so the browser needs fewer
 * round-trips for typical catalogs (~100 products).
 */
export async function processProductSyncJobUntilBudget(options: {
  shopDomain: string;
  client: AdminGraphqlClient;
  jobId?: string;
  budgetMs?: number;
}): Promise<{
  job: SyncJob;
  stats: ProductSyncStats;
  progress: Awaited<ReturnType<typeof getCatalogSyncProgress>>;
}> {
  const budgetMs = options.budgetMs ?? PRODUCT_SYNC_REQUEST_BUDGET_MS;
  const started = Date.now();
  let jobId = options.jobId;
  let last = await processProductSyncJobTick({
    shopDomain: options.shopDomain,
    client: options.client,
    jobId,
  });
  jobId = last.job.id;

  while (
    last.stats.hasMore &&
    last.job.status === SyncJobStatus.RUNNING &&
    Date.now() - started < budgetMs
  ) {
    last = await processProductSyncJobTick({
      shopDomain: options.shopDomain,
      client: options.client,
      jobId,
    });
  }

  return last;
}
