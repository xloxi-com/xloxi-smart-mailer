import {
  EmailJobStatus,
  FlowBatchStatus,
  MarketingConsentState,
  SyncJobType,
} from "../lib/prisma.server";
import prisma from "../db.server";
import { toMerchantSafeError } from "../lib/safe-error.server";

export async function getFlowDashboardStats(shopId: string) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    totalProducts,
    eligibleProducts,
    totalSubscribers,
    activeSubscribers,
    productsSelectedToday,
    pendingBatches,
    flowTriggered,
    flowAcknowledged,
    failedBatches,
    shop,
    latestProductSync,
    latestCustomerSync,
    lastAck,
  ] = await Promise.all([
    prisma.product.count({ where: { shopId, deletedAt: null } }),
    prisma.product.count({
      where: {
        shopId,
        deletedAt: null,
        eligible: true,
        excludedFromAutomation: false,
      },
    }),
    prisma.subscriber.count({ where: { shopId, deletedAt: null } }),
    prisma.subscriber.count({
      where: {
        shopId,
        deletedAt: null,
        eligible: true,
        isSuppressed: false,
        paused: false,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      },
    }),
    prisma.emailJobProduct.count({
      where: {
        shopId,
        emailJob: {
          createdAt: { gte: dayAgo },
          flowStatus: {
            in: [
              FlowBatchStatus.PENDING,
              FlowBatchStatus.READY,
              FlowBatchStatus.ACKNOWLEDGED,
            ],
          },
        },
      },
    }),
    prisma.emailJob.count({
      where: {
        shopId,
        flowStatus: {
          in: [FlowBatchStatus.PENDING, FlowBatchStatus.READY],
        },
      },
    }),
    prisma.emailJob.count({
      where: {
        shopId,
        triggerSource: { in: ["flow_request", "app_scheduler", "test"] },
      },
    }),
    prisma.emailJob.count({
      where: { shopId, flowStatus: FlowBatchStatus.ACKNOWLEDGED },
    }),
    prisma.emailJob.count({
      where: {
        shopId,
        OR: [
          { flowStatus: FlowBatchStatus.FAILED },
          { status: EmailJobStatus.FAILED },
        ],
      },
    }),
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
      where: { shopId, flowStatus: FlowBatchStatus.ACKNOWLEDGED },
      orderBy: { acknowledgedAt: "desc" },
      select: {
        id: true,
        acknowledgedAt: true,
        subscriberId: true,
      },
    }),
  ]);

  return {
    totals: {
      totalProducts,
      eligibleProducts,
      totalSubscribers,
      activeSubscribers,
      productsSelectedToday,
      pendingBatches,
      flowTriggered,
      flowAcknowledged,
      failedBatches,
    },
    sync: {
      lastSyncAt: shop.lastSyncAt?.toISOString() ?? null,
      timezone: shop.timezone,
      automationEnabled: shop.automationSettings?.automationEnabled ?? false,
      testMode: shop.automationSettings?.testMode ?? true,
      appSchedulerEnabled:
        shop.automationSettings?.appSchedulerEnabled ?? false,
      intervalDays: shop.automationSettings?.intervalDays ?? 3,
      productsPerEmail: shop.automationSettings?.productsPerEmail ?? 6,
      inStockOnly: shop.automationSettings?.inStockOnly ?? true,
      integration: shop.automationSettings?.emailProviderLabel ?? "shopify_messaging",
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
