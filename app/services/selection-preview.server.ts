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
import { reserveEmailBatch } from "./email-reservation.server";
import { processCustomerFlowUpdate } from "./flow-selection.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { tagsAdd } from "./customer-tags-metafields.server";
import { XLOXI_TAG_REQUEST } from "./flow-tags.server";

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
}) {
  const subscriber = await prisma.subscriber.findFirstOrThrow({
    where: { id: options.subscriberId, shopId: options.shopId },
  });

  // Clear nextEmailAt gate for explicit test (does not enable production automation).
  if (subscriber.nextEmailAt && subscriber.nextEmailAt > new Date()) {
    await prisma.subscriber.update({
      where: { id: subscriber.id },
      data: { nextEmailAt: new Date() },
    });
  }

  const reserved = await reserveEmailBatch({
    shopId: options.shopId,
    subscriberId: subscriber.id,
    idempotencyKey: `test:${subscriber.id}:${Date.now()}`,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    dryRun: true,
    inStockOnly: options.inStockOnly !== false,
    intervalDays: options.intervalDays ?? 3,
  });

  if (reserved.status !== "reserved" && reserved.status !== "active_job_exists") {
    return { ok: false as const, reserved };
  }

  await prisma.emailJob.update({
    where: { id: reserved.job.id },
    data: { triggerSource: "test" },
  });

  // Tag customer so the same Flow pipeline applies tags/metafields.
  await tagsAdd(
    options.client,
    options.shopDomain,
    subscriber.shopifyCustomerGid,
    [XLOXI_TAG_REQUEST],
  );

  const flow = await processCustomerFlowUpdate({
    client: options.client,
    shopDomain: options.shopDomain,
    shopId: options.shopId,
    customerGid: subscriber.shopifyCustomerGid,
    intervalDays: options.intervalDays ?? 3,
    productsPerEmail: options.batchSize ?? DEFAULT_BATCH_SIZE,
    inStockOnly: options.inStockOnly !== false,
    automationEnabled: false,
    testMode: true,
  });

  return { ok: true as const, reserved, flow };
}
