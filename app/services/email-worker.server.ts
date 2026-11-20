/**
 * Legacy email worker — DISABLED.
 * XLOXI no longer delivers email; Shopify Messaging is the only send path.
 * Kept as a no-op so old Cloud Run job schedules fail closed safely.
 */
import { EmailJobStatus, MarketingConsentState } from "../lib/prisma.server";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  brandConfigFromSettings,
  renderProductEmail,
  type EmailProduct,
} from "../templates/product-email.server";
import {
  deliverMarketingEmail,
  reconcileUnknownEmailJob,
} from "./email-delivery.server";
import { getEmailProvider } from "./email-provider.server";
import {
  revalidateJobProductsBeforeFirstSend,
  type EmailJobWithProducts,
} from "./email-reservation.server";
import {
  claimEmailJobs,
  createWorkerId,
  deadLetterEmailJob,
  emptyWorkerMetrics,
  finishWorkerHeartbeat,
  pulseWorkerHeartbeat,
  recoverStaleEmailJobLeases,
  renewEmailJobLease,
  scheduleRetryOrDeadLetter,
  startWorkerHeartbeat,
  type WorkerMetrics,
} from "./job-queue.server";

export type EmailWorkerOptions = {
  batchSize?: number;
  concurrency?: number;
  /** Soft deadline for Cloud Run Jobs (ms from start). */
  maxRuntimeMs?: number;
  leaseMs?: number;
  shopId?: string;
  workerId?: string;
  /** Injected for tests. */
  processJob?: (job: EmailJobWithProducts) => Promise<ProcessJobResult>;
};

export type ProcessJobResult = {
  outcome: "accepted" | "dry_run" | "skipped" | "failed" | "retried" | "unknown" | "dead_letter";
  reason?: string;
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getEmailWorkerDefaults(): Required<
  Pick<EmailWorkerOptions, "batchSize" | "concurrency" | "maxRuntimeMs" | "leaseMs">
> {
  return {
    batchSize: readInt("WORKER_BATCH_SIZE", 20),
    concurrency: readInt("WORKER_CONCURRENCY", 5),
    maxRuntimeMs: readInt("WORKER_MAX_RUNTIME_MS", 240_000),
    leaseMs: readInt("WORKER_LEASE_MS", 120_000),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Process a single claimed email job end-to-end.
 */
export async function processClaimedEmailJob(
  job: EmailJobWithProducts,
  leaseOwner: string,
): Promise<ProcessJobResult> {
  await renewEmailJobLease(job.id, leaseOwner);

  const shop = await prisma.shop.findUnique({
    where: { id: job.shopId },
    include: { automationSettings: true },
  });
  if (!shop || shop.uninstalledAt || !shop.automationSettings?.automationEnabled) {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
        lastErrorCode: "shop_disabled",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return { outcome: "skipped", reason: "shop_disabled" };
  }

  const subscriber = await prisma.subscriber.findUnique({
    where: { id: job.subscriberId },
  });
  if (
    !subscriber ||
    subscriber.deletedAt ||
    subscriber.isSuppressed ||
    !subscriber.eligible ||
    subscriber.marketingConsentState !== MarketingConsentState.SUBSCRIBED
  ) {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
        lastErrorCode: "subscriber_ineligible",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return { outcome: "skipped", reason: "subscriber_ineligible" };
  }

  // Revalidate stock/eligibility before first send; reuse batch on retries.
  let readyJob = job;
  if (job.attemptCount <= 1) {
    readyJob = await revalidateJobProductsBeforeFirstSend(job.id, {
      inStockOnly: shop.automationSettings.inStockOnly !== false,
      batchSize: shop.automationSettings.productsPerEmail ?? 6,
    });
    if (readyJob.status === EmailJobStatus.CANCELLED) {
      return { outcome: "skipped", reason: "no_eligible_products" };
    }
  }

  if (readyJob.products.length === 0) {
    await prisma.emailJob.update({
      where: { id: readyJob.id },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
        lastErrorCode: "empty_batch",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return { outcome: "skipped", reason: "empty_batch" };
  }

  const products: EmailProduct[] = readyJob.products.map((p) => ({
    id: p.productId,
    title: p.title,
    handle: p.handle,
    imageUrl: p.imageUrl,
    productUrl: p.productUrl,
    price: p.price?.toString() ?? null,
    currencyCode: p.currencyCode,
  }));

  const rendered = renderProductEmail({
    products,
    brand: brandConfigFromSettings(shop.automationSettings, shop.shopDomain),
  });

  try {
    const result = await deliverMarketingEmail({
      emailJobId: readyJob.id,
      to: subscriber.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      shopDomain: shop.shopDomain,
      leaseOwner,
      intervalDays: shop.automationSettings.intervalDays ?? 3,
      alreadyClaimedJob: readyJob,
    });

    if (result.status === "accepted" || result.status === "dry_run") {
      return { outcome: result.status === "dry_run" ? "dry_run" : "accepted" };
    }
    if (result.status === "skipped") {
      return { outcome: "skipped", reason: result.reason };
    }
    if (result.status === "retry_scheduled") {
      return { outcome: "retried", reason: result.reason };
    }
    if (result.status === "unknown") {
      // Attempt immediate reconcile for accepted-but-unfinalized cases.
      const reconciled = await reconcileUnknownEmailJob(
        readyJob.id,
        getEmailProvider(),
      );
      if (reconciled.status === "accepted") {
        return { outcome: "accepted", reason: "recovered_after_ambiguous" };
      }
      return { outcome: "unknown", reason: result.reason };
    }
    return { outcome: "failed", reason: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker_error";
    const retryable =
      /timeout|ECONNRESET|429|rate|temporar/i.test(message) ||
      message === "provider_timeout";

    // If provider may have accepted but DB finalize failed, mark UNKNOWN for reconcile.
    if (/finaliz|commit|transaction/i.test(message)) {
      await prisma.emailJob.update({
        where: { id: readyJob.id },
        data: {
          status: EmailJobStatus.UNKNOWN,
          lastErrorCode: "finalize_failed",
          lastErrorMessage: message.slice(0, 1000),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return { outcome: "unknown", reason: "finalize_failed" };
    }

    const decision = await scheduleRetryOrDeadLetter(readyJob, {
      code: "worker_exception",
      message,
      retryable,
    });
    return {
      outcome: decision === "dead_letter" ? "dead_letter" : "retried",
      reason: message,
    };
  }
}

/**
 * Run one bounded worker invocation (Cloud Run Job entry).
 */
export async function runEmailWorker(
  options: EmailWorkerOptions = {},
): Promise<{ workerId: string; metrics: WorkerMetrics }> {
  const workerId = options.workerId ?? createWorkerId("email-worker");
  const metrics = emptyWorkerMetrics();
  // Messaging-only architecture: never claim or deliver email jobs.
  if (process.env.XLOXI_ALLOW_LEGACY_EMAIL_WORKER !== "true") {
    logger.info("email_worker_disabled_use_shopify_messaging", { workerId });
    return { workerId, metrics };
  }

  const defaults = getEmailWorkerDefaults();
  const batchSize = options.batchSize ?? defaults.batchSize;
  const concurrency = options.concurrency ?? defaults.concurrency;
  const maxRuntimeMs = options.maxRuntimeMs ?? defaults.maxRuntimeMs;
  const leaseMs = options.leaseMs ?? defaults.leaseMs;
  const deadline = Date.now() + maxRuntimeMs;

  // Concurrent workers are safe via SKIP LOCKED — no global mutex required.
  const heartbeatId = await startWorkerHeartbeat({
    workerId,
    workerType: "email_worker",
    metrics,
  });

  try {
    metrics.staleRecovered = await recoverStaleEmailJobLeases();

    while (Date.now() < deadline) {
      const claimed = await claimEmailJobs({
        limit: batchSize,
        leaseOwner: workerId,
        leaseMs,
        shopId: options.shopId,
      });
      if (claimed.length === 0) break;

      metrics.claimed += claimed.length;

      const processFn =
        options.processJob ??
        ((job: EmailJobWithProducts) => processClaimedEmailJob(job, workerId));

      const outcomes = await mapPool(claimed, concurrency, async (job) => {
        try {
          return await processFn(job);
        } catch (error) {
          metrics.errors += 1;
          logger.error("email_worker_job_crash", {
            emailJobId: job.id,
            name: error instanceof Error ? error.name : "unknown",
          });
          await deadLetterEmailJob(job.id, {
            code: "worker_crash",
            message: error instanceof Error ? error.message : "crash",
          });
          return {
            outcome: "dead_letter" as const,
            reason: "crash",
          };
        }
      });

      for (const outcome of outcomes) {
        metrics.processed += 1;
        if (outcome.outcome === "accepted" || outcome.outcome === "dry_run") {
          metrics.accepted += 1;
        } else if (outcome.outcome === "skipped") {
          metrics.skipped += 1;
        } else if (outcome.outcome === "retried") {
          metrics.retried += 1;
        } else if (outcome.outcome === "dead_letter") {
          metrics.deadLetter += 1;
        } else if (outcome.outcome === "failed") {
          metrics.failed += 1;
        }
      }

      await pulseWorkerHeartbeat(heartbeatId, metrics);

      if (Date.now() >= deadline) break;
    }

    await finishWorkerHeartbeat(heartbeatId, metrics, "succeeded");
    logger.info("email_worker_complete", { workerId, ...metrics });
  } catch (error) {
    metrics.errors += 1;
    const message = error instanceof Error ? error.message : "worker_failed";
    await finishWorkerHeartbeat(heartbeatId, metrics, "failed", message);
    logger.error("email_worker_failed", {
      workerId,
      name: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }

  return { workerId, metrics };
}
