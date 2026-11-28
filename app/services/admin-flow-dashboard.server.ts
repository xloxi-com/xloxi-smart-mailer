import { SyncJobType } from "../lib/prisma.server";
import prisma from "../db.server";
import { toMerchantSafeError } from "../lib/safe-error.server";

type DashboardCounts = {
  total_products: number;
  eligible_products: number;
  total_subscribers: number;
  active_subscribers: number;
  products_selected_today: number;
  pending_batches: number;
  flow_triggered: number;
  flow_acknowledged: number;
  failed_batches: number;
};

function n(value: number | bigint | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Single-roundtrip dashboard stats for Admin home.
 * Cuts many parallel COUNT roundtrips that hurt Vercel + pooler latency.
 */
export async function getFlowDashboardStats(shopId: string) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [countsRow, shop, latestProductSync, latestCustomerSync, lastAck] =
    await Promise.all([
      prisma.$queryRaw<DashboardCounts[]>`
        SELECT
          (SELECT COUNT(*)::int FROM "Product"
            WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL) AS total_products,
          (SELECT COUNT(*)::int FROM "Product"
            WHERE "shopId" = ${shopId}
              AND "deletedAt" IS NULL
              AND eligible = true
              AND "excludedFromAutomation" = false) AS eligible_products,
          (SELECT COUNT(*)::int FROM "Subscriber"
            WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL) AS total_subscribers,
          (SELECT COUNT(*)::int FROM "Subscriber"
            WHERE "shopId" = ${shopId}
              AND "deletedAt" IS NULL
              AND eligible = true
              AND "isSuppressed" = false
              AND paused = false
              AND "marketingConsentState" = 'SUBSCRIBED') AS active_subscribers,
          (SELECT COUNT(*)::int FROM "EmailJobProduct" ejp
            INNER JOIN "EmailJob" ej ON ej.id = ejp."emailJobId"
            WHERE ejp."shopId" = ${shopId}
              AND ej."createdAt" >= ${dayAgo}
              AND ej."flowStatus" IN ('PENDING', 'READY', 'ACKNOWLEDGED')
          ) AS products_selected_today,
          (SELECT COUNT(*)::int FROM "EmailJob"
            WHERE "shopId" = ${shopId}
              AND "flowStatus" IN ('PENDING', 'READY')
          ) AS pending_batches,
          (SELECT COUNT(*)::int FROM "EmailJob"
            WHERE "shopId" = ${shopId}
              AND "triggerSource" IN ('flow_request', 'app_scheduler', 'test')
          ) AS flow_triggered,
          (SELECT COUNT(*)::int FROM "EmailJob"
            WHERE "shopId" = ${shopId}
              AND "flowStatus" = 'ACKNOWLEDGED'
          ) AS flow_acknowledged,
          (SELECT COUNT(*)::int FROM "EmailJob"
            WHERE "shopId" = ${shopId}
              AND ("flowStatus" = 'FAILED' OR status = 'FAILED')
          ) AS failed_batches
      `,
      prisma.shop.findUniqueOrThrow({
        where: { id: shopId },
        select: {
          lastSyncAt: true,
          timezone: true,
          automationSettings: {
            select: {
              automationEnabled: true,
              testMode: true,
              appSchedulerEnabled: true,
              intervalDays: true,
              productsPerEmail: true,
              inStockOnly: true,
              emailProviderLabel: true,
            },
          },
        },
      }),
      prisma.syncJob.findFirst({
        where: { shopId, type: SyncJobType.PRODUCTS },
        orderBy: { updatedAt: "desc" },
        select: {
          status: true,
          updatedAt: true,
          completedAt: true,
          lastError: true,
        },
      }),
      prisma.syncJob.findFirst({
        where: { shopId, type: SyncJobType.CUSTOMERS },
        orderBy: { updatedAt: "desc" },
        select: {
          status: true,
          updatedAt: true,
          completedAt: true,
          lastError: true,
        },
      }),
      prisma.emailJob.findFirst({
        where: { shopId, flowStatus: "ACKNOWLEDGED" },
        orderBy: { acknowledgedAt: "desc" },
        select: {
          id: true,
          acknowledgedAt: true,
          subscriberId: true,
        },
      }),
    ]);

  const counts = countsRow[0] ?? {
    total_products: 0,
    eligible_products: 0,
    total_subscribers: 0,
    active_subscribers: 0,
    products_selected_today: 0,
    pending_batches: 0,
    flow_triggered: 0,
    flow_acknowledged: 0,
    failed_batches: 0,
  };

  return {
    totals: {
      totalProducts: n(counts.total_products),
      eligibleProducts: n(counts.eligible_products),
      totalSubscribers: n(counts.total_subscribers),
      activeSubscribers: n(counts.active_subscribers),
      productsSelectedToday: n(counts.products_selected_today),
      pendingBatches: n(counts.pending_batches),
      flowTriggered: n(counts.flow_triggered),
      flowAcknowledged: n(counts.flow_acknowledged),
      failedBatches: n(counts.failed_batches),
    },
    sync: {
      lastSyncAt: shop.lastSyncAt?.toISOString() ?? null,
      timezone: shop.timezone,
      automationEnabled: shop.automationSettings?.automationEnabled ?? false,
      testMode: shop.automationSettings?.testMode ?? true,
      appSchedulerEnabled:
        shop.automationSettings?.appSchedulerEnabled ?? false,
      intervalDays: shop.automationSettings?.intervalDays ?? 3,
      productsPerEmail: shop.automationSettings?.productsPerEmail ?? 4,
      inStockOnly: shop.automationSettings?.inStockOnly ?? true,
      integration:
        shop.automationSettings?.emailProviderLabel ?? "shopify_messaging",
      productSync: latestProductSync
        ? {
            status: latestProductSync.status,
            updatedAt: latestProductSync.updatedAt.toISOString(),
            lastError: latestProductSync.lastError
              ? toMerchantSafeError(latestProductSync.lastError)
              : null,
          }
        : null,
      customerSync: latestCustomerSync
        ? {
            status: latestCustomerSync.status,
            updatedAt: latestCustomerSync.updatedAt.toISOString(),
            lastError: latestCustomerSync.lastError
              ? toMerchantSafeError(latestCustomerSync.lastError)
              : null,
          }
        : null,
    },
    lastAcknowledgement: lastAck
      ? {
          batchId: lastAck.id,
          at: lastAck.acknowledgedAt?.toISOString() ?? null,
        }
      : null,
  };
}
