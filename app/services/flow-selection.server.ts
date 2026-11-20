/**
 * Flow-triggered random product selection → customer tags + metafields.
 *
 * Lifecycle:
 * 1. Detect xloxi-request on customers/update webhook
 * 2. Verify consent + next eligible date
 * 3. Reserve unique batch (EmailJob) — no duplicate pending batches
 * 4. Commit product history (prevents reselection)
 * 5. Remove previous completed XLOXI selection tags only
 * 6. Add xloxi-pick:handle tags + pending_batch_id metafield
 * 7. Add xloxi-ready last, then remove xloxi-request
 * 8. On processed_batch_id acknowledgement → mark ACKNOWLEDGED (not delivery)
 */
import { EmailJobStatus, FlowBatchStatus, MarketingConsentState } from "../lib/prisma.server";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { commitProductHistoryAfterAcceptance } from "./product-history.server";
import { reserveEmailBatch } from "./email-reservation.server";
import {
  fetchCustomerFlowSnapshot,
  setCustomerXloxiMetafields,
  tagsAdd,
  tagsRemove,
} from "./customer-tags-metafields.server";
import {
  XLOXI_METAFIELD_KEYS,
  XLOXI_TAG_READY,
  XLOXI_TAG_REQUEST,
  hasReadyTag,
  hasRequestTag,
  listCompletedSelectionTags,
  pickTagForHandle,
} from "./flow-tags.server";
import { calculateNextEmailAt } from "./consent.server";

export type FlowSelectionResult =
  | { status: "skipped"; reason: string }
  | { status: "ready"; batchId: string; productCount: number; reused: boolean }
  | { status: "acknowledged"; batchId: string }
  | { status: "failed"; reason: string };

function isSubscribed(marketingState: string | null | undefined): boolean {
  return (marketingState ?? "").toUpperCase() === "SUBSCRIBED";
}

/**
 * Process a customer update for Flow request / acknowledgement.
 * Guarded against recursion: ignores events that only contain our write-back tags
 * when request is absent and acknowledgement already synced.
 */
export async function processCustomerFlowUpdate(options: {
  client: AdminGraphqlClient;
  shopDomain: string;
  shopId: string;
  customerGid: string;
  intervalDays: number;
  productsPerEmail: number;
  inStockOnly: boolean;
  automationEnabled: boolean;
  testMode: boolean;
}): Promise<FlowSelectionResult> {
  const snapshot = await fetchCustomerFlowSnapshot(
    options.client,
    options.shopDomain,
    options.customerGid,
  );
  if (!snapshot) {
    return { status: "skipped", reason: "customer_not_found" };
  }

  const subscriber = await prisma.subscriber.findUnique({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: options.shopId,
        shopifyCustomerGid: options.customerGid,
      },
    },
  });
  if (!subscriber || subscriber.deletedAt) {
    return { status: "skipped", reason: "subscriber_not_mirrored" };
  }

  // Sync metafield mirrors locally (acknowledgement path).
  const processedId = snapshot.metafields.processedBatchId;
  if (processedId && processedId !== subscriber.processedBatchId) {
    const matchesPending =
      subscriber.pendingBatchId != null &&
      processedId === subscriber.pendingBatchId;
    const readyJob = await prisma.emailJob.findFirst({
      where: {
        id: processedId,
        shopId: options.shopId,
        subscriberId: subscriber.id,
        flowStatus: {
          in: [FlowBatchStatus.READY, FlowBatchStatus.PENDING],
        },
      },
      select: { id: true },
    });

    if (matchesPending || readyJob) {
      const ack = await acknowledgeFlowBatch({
        shopId: options.shopId,
        subscriberId: subscriber.id,
        batchId: processedId,
        intervalDays: options.intervalDays,
      });
      if (ack.status === "acknowledged") {
        return ack;
      }
    } else {
      // Ambiguous processed id — mirror only; do not auto-retry.
      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          processedBatchId: processedId,
          lastProcessedAt: snapshot.metafields.lastProcessedAt
            ? new Date(snapshot.metafields.lastProcessedAt)
            : new Date(),
        },
      });
    }
  }

  if (!hasRequestTag(snapshot.tags)) {
    return { status: "skipped", reason: "no_request_tag" };
  }

  // Recursion guard: already ready with pending batch matching metafield.
  if (
    hasReadyTag(snapshot.tags) &&
    snapshot.metafields.pendingBatchId &&
    subscriber.pendingBatchId === snapshot.metafields.pendingBatchId
  ) {
    // Still remove request if Flow left it on.
    try {
      await tagsRemove(
        options.client,
        options.shopDomain,
        options.customerGid,
        [XLOXI_TAG_REQUEST],
      );
    } catch {
      /* ignore */
    }
    return {
      status: "ready",
      batchId: snapshot.metafields.pendingBatchId,
      productCount: 0,
      reused: true,
    };
  }

  if (!options.automationEnabled && !options.testMode) {
    return { status: "skipped", reason: "automation_disabled" };
  }

  if (!isSubscribed(snapshot.marketingState)) {
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    ).catch(() => undefined);
    return { status: "skipped", reason: "consent_not_subscribed" };
  }

  if (subscriber.marketingConsentState !== MarketingConsentState.SUBSCRIBED) {
    return { status: "skipped", reason: "mirror_consent_not_subscribed" };
  }

  if (subscriber.isSuppressed || subscriber.paused || !subscriber.eligible) {
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    ).catch(() => undefined);
    return { status: "skipped", reason: "subscriber_ineligible" };
  }

  const now = new Date();
  if (subscriber.nextEmailAt && subscriber.nextEmailAt > now) {
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    ).catch(() => undefined);
    return { status: "skipped", reason: "next_selection_not_due" };
  }

  const idempotencyKey = `flow:${subscriber.id}:${subscriber.nextEmailAt?.toISOString() ?? "immediate"}:${Date.now()}`;

  const reserved = await reserveEmailBatch({
    shopId: options.shopId,
    subscriberId: subscriber.id,
    idempotencyKey,
    batchSize: options.productsPerEmail,
    dryRun: true,
    inStockOnly: options.inStockOnly,
    intervalDays: options.intervalDays,
  });

  if (reserved.status === "subscriber_ineligible") {
    return { status: "skipped", reason: reserved.reason };
  }
  if (reserved.status === "skipped_no_products") {
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    ).catch(() => undefined);
    return { status: "skipped", reason: "no_eligible_products" };
  }

  const job =
    reserved.status === "active_job_exists" ? reserved.job : reserved.job;
  const reused =
    reserved.status === "active_job_exists" ||
    (reserved.status === "reserved" && reserved.reused);

  // If an active job is already FLOW_READY, just clean request tag.
  if (
    job.flowStatus === FlowBatchStatus.READY ||
    job.flowStatus === FlowBatchStatus.ACKNOWLEDGED
  ) {
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    ).catch(() => undefined);
    return {
      status: "ready",
      batchId: job.id,
      productCount: job.products.length,
      reused: true,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await commitProductHistoryAfterAcceptance(tx, {
        shopId: options.shopId,
        subscriberId: subscriber.id,
        cycleNumber: job.cycleNumber,
        emailJobId: job.id,
        productIds: job.products.map((p) => p.productId),
      });

      await tx.emailJob.update({
        where: { id: job.id },
        data: {
          flowStatus: FlowBatchStatus.PENDING,
          triggerSource: reused ? job.triggerSource ?? "flow_request" : "flow_request",
          status: EmailJobStatus.PENDING,
          providerName: "shopify_messaging",
        },
      });

      await tx.subscriber.update({
        where: { id: subscriber.id },
        data: { pendingBatchId: job.id },
      });
    });

    const handles = job.products
      .map((p) => p.handle)
      .filter((h): h is string => Boolean(h && h.trim()));

    if (handles.length === 0) {
      throw new Error("selected_products_missing_handles");
    }

    const previousSelectionTags = listCompletedSelectionTags(snapshot.tags);
    if (previousSelectionTags.length > 0) {
      await tagsRemove(
        options.client,
        options.shopDomain,
        options.customerGid,
        previousSelectionTags,
      );
    }

    const pickTags = handles.map(pickTagForHandle);
    await tagsAdd(
      options.client,
      options.shopDomain,
      options.customerGid,
      pickTags,
    );

    const nextAt = calculateNextEmailAt({
      shopId: options.shopId,
      shopifyCustomerGid: options.customerGid,
      intervalDays: options.intervalDays,
      lastSuccessfulEmailAt: now,
      staggerInitial: false,
    });

    await setCustomerXloxiMetafields(
      options.client,
      options.shopDomain,
      options.customerGid,
      [
        {
          key: XLOXI_METAFIELD_KEYS.pendingBatchId,
          type: "single_line_text_field",
          value: job.id,
        },
        {
          key: XLOXI_METAFIELD_KEYS.nextSelectionAt,
          type: "date_time",
          value: nextAt.toISOString(),
        },
      ],
    );

    // Final operation: ready tag, then remove request (prevents Flow races).
    await tagsAdd(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_READY],
    );
    await tagsRemove(
      options.client,
      options.shopDomain,
      options.customerGid,
      [XLOXI_TAG_REQUEST],
    );

    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        flowStatus: FlowBatchStatus.READY,
        flowReadyAt: new Date(),
      },
    });

    logger.info("flow_selection_ready", {
      shop: options.shopDomain,
      batchId: job.id,
      products: handles.length,
    });

    return {
      status: "ready",
      batchId: job.id,
      productCount: handles.length,
      reused,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "flow_selection_failed";
    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        flowStatus: FlowBatchStatus.FAILED,
        lastErrorCode: "flow_selection_failed",
        lastErrorMessage: reason.slice(0, 500),
        status: EmailJobStatus.FAILED,
        completedAt: new Date(),
      },
    });
    logger.error("flow_selection_failed", {
      shop: options.shopDomain,
      batchId: job.id,
    });
    return { status: "failed", reason: "flow_selection_failed" };
  }
}

export async function acknowledgeFlowBatch(options: {
  shopId: string;
  subscriberId: string;
  batchId: string;
  intervalDays: number;
}): Promise<FlowSelectionResult> {
  const job = await prisma.emailJob.findFirst({
    where: {
      id: options.batchId,
      shopId: options.shopId,
      subscriberId: options.subscriberId,
    },
  });
  if (!job) {
    return { status: "skipped", reason: "batch_not_found" };
  }
  if (job.flowStatus === FlowBatchStatus.ACKNOWLEDGED) {
    return { status: "acknowledged", batchId: job.id };
  }

  const now = new Date();
  const nextAt = new Date(
    now.getTime() + options.intervalDays * 24 * 60 * 60 * 1000,
  );

  await prisma.$transaction([
    prisma.emailJob.update({
      where: { id: job.id },
      data: {
        flowStatus: FlowBatchStatus.ACKNOWLEDGED,
        acknowledgedAt: now,
        status: EmailJobStatus.ACCEPTED,
        completedAt: job.completedAt ?? now,
        providerName: "shopify_messaging",
      },
    }),
    prisma.subscriber.update({
      where: { id: options.subscriberId },
      data: {
        processedBatchId: job.id,
        pendingBatchId: null,
        lastProcessedAt: now,
        lastSuccessfulEmailAt: now,
        nextEmailAt: nextAt,
      },
    }),
  ]);

  // Note: acknowledgement ≠ confirmed email delivery.
  logger.info("flow_batch_acknowledged", {
    shopId: options.shopId,
    batchId: job.id,
  });

  return { status: "acknowledged", batchId: job.id };
}

/**
 * Optional app-managed scheduler: tag due subscribers with xloxi-request
 * in chunks of 100 to avoid Flow Get customer data starvation.
 */
export async function tagDueSubscribersWithRequest(options: {
  client: AdminGraphqlClient;
  shopDomain: string;
  shopId: string;
  limit?: number;
}): Promise<{ tagged: number; skipped: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const due = await prisma.subscriber.findMany({
    where: {
      shopId: options.shopId,
      deletedAt: null,
      eligible: true,
      isSuppressed: false,
      paused: false,
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      OR: [{ nextEmailAt: null }, { nextEmailAt: { lte: new Date() } }],
      // Avoid re-tagging customers who already have a pending Flow batch.
      pendingBatchId: null,
    },
    orderBy: [{ nextEmailAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, shopifyCustomerGid: true },
  });

  let tagged = 0;
  let skipped = 0;
  for (const sub of due) {
    try {
      await tagsAdd(
        options.client,
        options.shopDomain,
        sub.shopifyCustomerGid,
        [XLOXI_TAG_REQUEST],
      );
      tagged += 1;
    } catch {
      skipped += 1;
    }
  }
  return { tagged, skipped };
}
