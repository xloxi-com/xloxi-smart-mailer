/**
 * Flow-triggered random product selection → customer tags + metafields.
 *
 * Lifecycle:
 * 1. Detect xloxi-request on customers/update webhook
 * 2. Verify consent (+ next-due gate only after a completed send)
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

async function removeRequestTag(
  client: AdminGraphqlClient,
  shopDomain: string,
  customerGid: string,
): Promise<void> {
  try {
    await tagsRemove(client, shopDomain, customerGid, [XLOXI_TAG_REQUEST]);
  } catch {
    /* ignore */
  }
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
  /** Bypass nextEmailAt even after a completed send (safe single-customer test). */
  forceProcess?: boolean;
}): Promise<FlowSelectionResult> {
  const snapshot = await fetchCustomerFlowSnapshot(
    options.client,
    options.shopDomain,
    options.customerGid,
  );
  if (!snapshot) {
    logger.info("flow_selection_skip", {
      shop: options.shopDomain,
      customerGid: options.customerGid,
      reason: "customer_not_found",
    });
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
    logger.info("flow_selection_skip", {
      shop: options.shopDomain,
      customerGid: options.customerGid,
      reason: "subscriber_not_mirrored",
    });
    return { status: "skipped", reason: "subscriber_not_mirrored" };
  }

  // Sync metafield mirrors locally (acknowledgement path).
  const processedId = snapshot.metafields.processedBatchId;
  if (processedId && processedId !== subscriber.processedBatchId) {
    const matchesPending =
      subscriber.pendingBatchId != null &&
      processedId === subscriber.pendingBatchId;
    const ackableJob = await prisma.emailJob.findFirst({
      where: {
        id: processedId,
        shopId: options.shopId,
        subscriberId: subscriber.id,
      },
      select: { id: true, flowStatus: true },
    });

    if (matchesPending || ackableJob) {
      const ack = await acknowledgeFlowBatch({
        shopId: options.shopId,
        subscriberId: subscriber.id,
        batchId: processedId,
        intervalDays: options.intervalDays,
        client: options.client,
        shopDomain: options.shopDomain,
        customerGid: options.customerGid,
      });
      if (ack.status === "acknowledged") {
        // Continue only if a fresh request tag is also present.
        if (!hasRequestTag(snapshot.tags)) {
          return ack;
        }
      }
    } else {
      // Unknown processed id — mirror only; do not auto-retry.
      await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          processedBatchId: processedId,
          lastProcessedAt: snapshot.metafields.lastProcessedAt
            ? new Date(snapshot.metafields.lastProcessedAt)
            : new Date(),
        },
      });
      logger.warn("flow_ack_unknown_batch", {
        shop: options.shopDomain,
        customerGid: options.customerGid,
        processedId,
      });
    }
  }

  if (!hasRequestTag(snapshot.tags)) {
    return { status: "skipped", reason: "no_request_tag" };
  }

  // Refresh subscriber after possible ack updates.
  const current = await prisma.subscriber.findUniqueOrThrow({
    where: { id: subscriber.id },
  });

  // Recursion guard: already ready with pending batch matching metafield.
  if (
    hasReadyTag(snapshot.tags) &&
    snapshot.metafields.pendingBatchId &&
    current.pendingBatchId === snapshot.metafields.pendingBatchId
  ) {
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
    logger.info("flow_selection_reuse_ready", {
      shop: options.shopDomain,
      batchId: snapshot.metafields.pendingBatchId,
    });
    return {
      status: "ready",
      batchId: snapshot.metafields.pendingBatchId,
      productCount: 0,
      reused: true,
    };
  }

  if (!options.automationEnabled && !options.testMode && !options.forceProcess) {
    logger.info("flow_selection_skip", {
      shop: options.shopDomain,
      reason: "automation_disabled",
    });
    return { status: "skipped", reason: "automation_disabled" };
  }

  if (!isSubscribed(snapshot.marketingState)) {
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
    return { status: "skipped", reason: "consent_not_subscribed" };
  }

  if (current.marketingConsentState !== MarketingConsentState.SUBSCRIBED) {
    return { status: "skipped", reason: "mirror_consent_not_subscribed" };
  }

  if (current.isSuppressed || current.paused || !current.eligible) {
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
    return { status: "skipped", reason: "subscriber_ineligible" };
  }

  const now = new Date();
  const notDue = current.nextEmailAt != null && current.nextEmailAt > now;
  const hasCompletedSend = current.lastSuccessfulEmailAt != null;
  /**
   * xloxi-request is the Flow/scheduler due signal.
   * Only enforce nextEmailAt after a completed send (prevents same-week doubles).
   * Never-sent subscribers (staggered nextEmailAt) must still process when tagged.
   * forceProcess (single-customer admin test) may bypass; testMode alone must not
   * create duplicate batches after acknowledgement.
   */
  if (notDue && hasCompletedSend && !options.forceProcess) {
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
    logger.info("flow_selection_skip", {
      shop: options.shopDomain,
      customerGid: options.customerGid,
      reason: "next_selection_not_due",
      nextEmailAt: current.nextEmailAt?.toISOString() ?? null,
    });
    return { status: "skipped", reason: "next_selection_not_due" };
  }

  if (notDue && (!hasCompletedSend || options.forceProcess)) {
    logger.info("flow_selection_due_bypass", {
      shop: options.shopDomain,
      customerGid: options.customerGid,
      forceProcess: Boolean(options.forceProcess),
      neverSent: !hasCompletedSend,
      nextEmailAt: current.nextEmailAt?.toISOString() ?? null,
    });
  }

  const slotKey =
    current.nextEmailAt?.toISOString() ??
    (hasCompletedSend ? "retry" : "first");
  const idempotencyKey = `flow:${current.id}:${slotKey}`;

  const reserved = await reserveEmailBatch({
    shopId: options.shopId,
    subscriberId: current.id,
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
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
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
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );
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
        subscriberId: current.id,
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
        where: { id: current.id },
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
    await removeRequestTag(
      options.client,
      options.shopDomain,
      options.customerGid,
    );

    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        flowStatus: FlowBatchStatus.READY,
        flowReadyAt: new Date(),
      },
    });

    // Advance local schedule when the batch is ready so the app scheduler
    // does not re-tag while Flow Messaging / ack is in flight.
    await prisma.subscriber.update({
      where: { id: current.id },
      data: {
        pendingBatchId: job.id,
        nextEmailAt: nextAt,
      },
    });

    logger.info("flow_selection_ready", {
      shop: options.shopDomain,
      batchId: job.id,
      products: handles.length,
      nextEmailAt: nextAt.toISOString(),
      reused,
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
    // Leave xloxi-request for a safe retry on the next customers/update.
    logger.error("flow_selection_failed", {
      shop: options.shopDomain,
      batchId: job.id,
      reason,
    });
    return { status: "failed", reason: "flow_selection_failed" };
  }
}

export async function acknowledgeFlowBatch(options: {
  shopId: string;
  subscriberId: string;
  batchId: string;
  intervalDays: number;
  client?: AdminGraphqlClient;
  shopDomain?: string;
  customerGid?: string;
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

  const subscriber = await prisma.subscriber.findUniqueOrThrow({
    where: { id: options.subscriberId },
  });

  const now = new Date();
  const ackAt = job.acknowledgedAt ?? now;
  const nextAt = calculateNextEmailAt({
    shopId: options.shopId,
    shopifyCustomerGid: subscriber.shopifyCustomerGid,
    intervalDays: options.intervalDays,
    lastSuccessfulEmailAt: ackAt,
    staggerInitial: false,
  });

  if (job.flowStatus === FlowBatchStatus.ACKNOWLEDGED) {
    // Repair subscriber mirror if Flow ack landed but local fields lagged.
    await prisma.subscriber.update({
      where: { id: options.subscriberId },
      data: {
        processedBatchId: job.id,
        pendingBatchId: null,
        lastProcessedAt: subscriber.lastProcessedAt ?? ackAt,
        lastSuccessfulEmailAt: subscriber.lastSuccessfulEmailAt ?? ackAt,
        nextEmailAt:
          subscriber.nextEmailAt && subscriber.nextEmailAt > now
            ? subscriber.nextEmailAt
            : nextAt,
      },
    });
    logger.info("flow_batch_ack_repair", {
      shopId: options.shopId,
      batchId: job.id,
    });
    return { status: "acknowledged", batchId: job.id };
  }

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

  if (options.client && options.shopDomain && options.customerGid) {
    try {
      await setCustomerXloxiMetafields(
        options.client,
        options.shopDomain,
        options.customerGid,
        [
          {
            key: XLOXI_METAFIELD_KEYS.lastProcessedAt,
            type: "date_time",
            value: now.toISOString(),
          },
          {
            key: XLOXI_METAFIELD_KEYS.nextSelectionAt,
            type: "date_time",
            value: nextAt.toISOString(),
          },
        ],
      );
    } catch (error) {
      logger.warn("flow_ack_metafield_sync_failed", {
        shop: options.shopDomain,
        batchId: job.id,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // Note: acknowledgement ≠ confirmed email delivery.
  logger.info("flow_batch_acknowledged", {
    shopId: options.shopId,
    batchId: job.id,
    nextEmailAt: nextAt.toISOString(),
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
      logger.info("flow_scheduler_tagged_request", {
        shop: options.shopDomain,
        subscriberId: sub.id,
      });
    } catch {
      skipped += 1;
    }
  }
  return { tagged, skipped };
}

/**
 * Safe single-customer Flow test: tags one subscriber with xloxi-request and
 * runs selection. Does not bulk-tag, does not toggle shop automation, and does
 * not reset product history.
 */
export async function runSafeSingleCustomerFlowTest(options: {
  client: AdminGraphqlClient;
  shopDomain: string;
  shopId: string;
  subscriberId: string;
  productsPerEmail?: number;
  inStockOnly?: boolean;
  intervalDays?: number;
}): Promise<{
  ok: boolean;
  flow: FlowSelectionResult;
  customerGid: string;
}> {
  const subscriber = await prisma.subscriber.findFirstOrThrow({
    where: { id: options.subscriberId, shopId: options.shopId },
  });

  logger.info("flow_single_customer_test_start", {
    shop: options.shopDomain,
    subscriberId: subscriber.id,
    customerGid: subscriber.shopifyCustomerGid,
  });

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
    productsPerEmail: options.productsPerEmail ?? 4,
    inStockOnly: options.inStockOnly !== false,
    automationEnabled: false,
    testMode: true,
    forceProcess: true,
  });

  logger.info("flow_single_customer_test_done", {
    shop: options.shopDomain,
    subscriberId: subscriber.id,
    status: flow.status,
  });

  return {
    ok: flow.status === "ready" || flow.status === "acknowledged",
    flow,
    customerGid: subscriber.shopifyCustomerGid,
  };
}
