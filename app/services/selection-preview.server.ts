/**
 * Preview / test batch helpers for Random Selection admin UI.
 * Preview never writes tags until the merchant confirms “Prepare test batch”.
 */
import prisma from "../db.server";
import { MarketingConsentState } from "../lib/prisma.server";
import {
  DEFAULT_BATCH_SIZE,
  planCycleSelection,
} from "./random-engine.server";
import {
  runSafeSingleCustomerFlowTest,
  type FlowSelectionResult,
} from "./flow-selection.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";

export async function listTestSubscribers(shopId: string, q?: string | null) {
  return prisma.subscriber.findMany({
    where: {
      shopId,
      deletedAt: null,
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      ...(q
        ? {
            OR: [
              { emailNormalized: { contains: q.toLowerCase() } },
              { shopifyCustomerGid: { contains: q } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      emailNormalized: true,
      shopifyCustomerGid: true,
      eligible: true,
      paused: true,
      currentCycleNumber: true,
      nextEmailAt: true,
      pendingBatchId: true,
    },
  });
}

export async function previewRandomSelection(options: {
  shopId: string;
  subscriberId: string;
  batchSize?: number;
  inStockOnly?: boolean;
}) {
  const subscriber = await prisma.subscriber.findFirstOrThrow({
    where: { id: options.subscriberId, shopId: options.shopId },
  });

  return prisma.$transaction(async (tx) => {
    const selection = await planCycleSelection(tx, {
      shopId: options.shopId,
      subscriberId: subscriber.id,
      currentCycleNumber: subscriber.currentCycleNumber,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      inStockOnly: options.inStockOnly !== false,
    });
    return selection;
  });
}

export async function prepareTestBatch(options: {
  client: AdminGraphqlClient;
  shopDomain: string;
  shopId: string;
  subscriberId: string;
  batchSize?: number;
  inStockOnly?: boolean;
  intervalDays?: number;
}): Promise<{
  ok: boolean;
  flow: FlowSelectionResult;
  reserved?: { status: string; job?: { id: string } };
}> {
  const result = await runSafeSingleCustomerFlowTest({
    client: options.client,
    shopDomain: options.shopDomain,
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    productsPerEmail: options.batchSize ?? DEFAULT_BATCH_SIZE,
    inStockOnly: options.inStockOnly !== false,
    intervalDays: options.intervalDays ?? 3,
  });

  return {
    ok: result.ok,
    flow: result.flow,
    reserved:
      result.flow.status === "ready" || result.flow.status === "acknowledged"
        ? { status: result.flow.status, job: { id: result.flow.batchId } }
        : { status: result.flow.status },
  };
}
