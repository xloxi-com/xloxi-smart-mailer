/**
 * Reserve an immutable product batch for a subscriber marketing email.
 *
 * Concurrency:
 * - Locks the subscriber row (`FOR UPDATE`) during reservation.
 * - At most one active job per subscriber (partial unique index + app check).
 * - Short transactions: select + insert job, then release.
 *
 * Lifecycle:
 * - Reuse the reserved batch on retries.
 * - Revalidate + top-up only before the first send attempt.
 * - Commit ProductHistory only after provider ACCEPTED.
 * - Ambiguous provider timeouts → UNKNOWN (no blind resend, no history).
 */
import type { EmailJob, EmailJobProduct, Prisma, Subscriber } from "@prisma/client";
import {
  EmailJobStatus,
  FlowBatchStatus,
  MarketingConsentState,
} from "../lib/prisma.server";
import prisma from "../db.server";
import { commitProductHistoryAfterAcceptance } from "./product-history.server";
import {
  DEFAULT_BATCH_SIZE,
  planCycleSelection,
  selectRandomEligibleProducts,
  type SelectedProduct,
} from "./random-engine.server";

type Tx = Prisma.TransactionClient;

export const ACTIVE_EMAIL_JOB_STATUSES: EmailJobStatus[] = [
  EmailJobStatus.PENDING,
  EmailJobStatus.PROCESSING,
  EmailJobStatus.RETRY_SCHEDULED,
  EmailJobStatus.UNKNOWN,
];

export type EmailJobWithProducts = EmailJob & { products: EmailJobProduct[] };

export type ProductSnapshotItem = {
  productId: string;
  shopifyProductGid: string;
  title: string;
  handle: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  price: string | null;
  currencyCode: string | null;
  position: number;
};

export type ReserveResult =
  | {
      status: "reserved";
      job: EmailJobWithProducts;
      reused: boolean;
      startedNewCycle: boolean;
    }
  | { status: "skipped_no_products" }
  | { status: "subscriber_ineligible"; reason: string }
  | { status: "active_job_exists"; job: EmailJobWithProducts };

export type ReserveOptions = {
  shopId: string;
  subscriberId: string;
  idempotencyKey: string;
  batchSize?: number;
  dryRun?: boolean;
  inStockOnly?: boolean;
  /** Optional cadence for nextEmailAt after acceptance. */
  intervalDays?: number;
};

function toSnapshotItems(products: SelectedProduct[]): ProductSnapshotItem[] {
  return products.map((p, position) => ({
    productId: p.id,
    shopifyProductGid: p.shopifyProductGid,
    title: p.title,
    handle: p.handle,
    imageUrl: p.imageUrl,
    productUrl: p.storefrontUrl,
    price: p.priceMin != null ? p.priceMin.toString() : null,
    currencyCode: p.currencyCode,
    position,
  }));
}

function assertSubscriberSendable(sub: Subscriber): string | null {
  if (sub.deletedAt) return "subscriber_deleted";
  if (!sub.eligible) return "subscriber_not_eligible";
  if (sub.isSuppressed) return "subscriber_suppressed";
  if (sub.paused) return "subscriber_paused";
  if (sub.marketingConsentState !== MarketingConsentState.SUBSCRIBED) {
    return "consent_not_subscribed";
  }
  return null;
}

async function findActiveJob(
  tx: Tx,
  shopId: string,
  subscriberId: string,
): Promise<EmailJobWithProducts | null> {
  return tx.emailJob.findFirst({
    where: {
      shopId,
      subscriberId,
      status: { in: ACTIVE_EMAIL_JOB_STATUSES },
    },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

async function createJobWithProducts(
  tx: Tx,
  options: {
    shopId: string;
    subscriberId: string;
    idempotencyKey: string;
    cycleNumber: number;
    dryRun: boolean;
    products: SelectedProduct[];
  },
): Promise<EmailJobWithProducts> {
  const snapshot = toSnapshotItems(options.products);
  return tx.emailJob.create({
    data: {
      shopId: options.shopId,
      subscriberId: options.subscriberId,
      idempotencyKey: options.idempotencyKey,
      status: EmailJobStatus.PENDING,
      cycleNumber: options.cycleNumber,
      dryRun: true,
      flowStatus: FlowBatchStatus.PENDING,
      triggerSource: "flow_request",
      providerName: "shopify_messaging",
      productSnapshot: { products: snapshot },
      products: {
        create: snapshot.map((item) => ({
          shopId: options.shopId,
          productId: item.productId,
          position: item.position,
          shopifyProductGid: item.shopifyProductGid,
          title: item.title,
          handle: item.handle,
          imageUrl: item.imageUrl,
          price: item.price,
          currencyCode: item.currencyCode,
          productUrl: item.productUrl,
        })),
      },
    },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

/**
 * Lock subscriber, select a non-repeating batch, and persist an immutable EmailJob.
 * If an active job already exists, returns it (batch reuse).
 */
export async function reserveEmailBatch(
  options: ReserveOptions,
  client: typeof prisma = prisma,
): Promise<ReserveResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = options.dryRun ?? true;
  const inStockOnly = options.inStockOnly !== false;

  try {
    return await client.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Subscriber[]>`
          SELECT *
          FROM "Subscriber"
          WHERE id = ${options.subscriberId}
            AND "shopId" = ${options.shopId}
          FOR UPDATE
        `;
        const subscriber = locked[0];
        if (!subscriber) {
          return {
            status: "subscriber_ineligible" as const,
            reason: "subscriber_not_found",
          };
        }

        const ineligible = assertSubscriberSendable(subscriber);
        if (ineligible) {
          return {
            status: "subscriber_ineligible" as const,
            reason: ineligible,
          };
        }

        const existing = await findActiveJob(
          tx,
          options.shopId,
          options.subscriberId,
        );
        if (existing) {
          return {
            status: "active_job_exists" as const,
            job: existing,
          };
        }

        // Idempotent create by key (retry of same reservation).
        const byKey = await tx.emailJob.findUnique({
          where: {
            shopId_idempotencyKey: {
              shopId: options.shopId,
              idempotencyKey: options.idempotencyKey,
            },
          },
          include: { products: { orderBy: { position: "asc" } } },
        });
        if (byKey) {
          return {
            status: "reserved" as const,
            job: byKey,
            reused: true,
            startedNewCycle: false,
          };
        }

        const selection = await planCycleSelection(tx, {
          shopId: options.shopId,
          subscriberId: options.subscriberId,
          currentCycleNumber: subscriber.currentCycleNumber,
          batchSize,
          inStockOnly,
        });

        if (!selection) {
          return { status: "skipped_no_products" as const };
        }

        if (selection.startedNewCycle) {
          await tx.subscriber.update({
            where: { id: subscriber.id },
            data: { currentCycleNumber: selection.cycleNumber },
          });
        }

        const job = await createJobWithProducts(tx, {
          shopId: options.shopId,
          subscriberId: options.subscriberId,
          idempotencyKey: options.idempotencyKey,
          cycleNumber: selection.cycleNumber,
          dryRun,
          products: selection.products,
        });

        return {
          status: "reserved" as const,
          job,
          reused: false,
          startedNewCycle: selection.startedNewCycle,
        };
      },
      {
        // Concurrent reserves lock the same subscriber; allow waiting for the lock.
        maxWait: 20_000,
        timeout: 20_000,
      },
    );
  } catch (error) {
    // Partial unique / idempotency race → return the winning active job.
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "";
    if (code === "P2002") {
      const existing = await findActiveJob(
        client,
        options.shopId,
        options.subscriberId,
      );
      if (existing) {
        return { status: "active_job_exists", job: existing };
      }
      const byKey = await client.emailJob.findUnique({
        where: {
          shopId_idempotencyKey: {
            shopId: options.shopId,
            idempotencyKey: options.idempotencyKey,
          },
        },
        include: { products: { orderBy: { position: "asc" } } },
      });
      if (byKey) {
        return {
          status: "reserved",
          job: byKey,
          reused: true,
          startedNewCycle: false,
        };
      }
    }
    throw error;
  }
}

/**
 * Revalidate reserved products before the first send attempt.
 * Unavailable items are dropped and topped up from remaining eligible stock.
 * After attemptCount > 0 the snapshot is immutable (retry reuse).
 */
export async function revalidateJobProductsBeforeFirstSend(
  emailJobId: string,
  options?: { inStockOnly?: boolean; batchSize?: number },
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts> {
  const inStockOnly = options?.inStockOnly !== false;
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;

  return client.$transaction(async (tx) => {
    const job = await tx.emailJob.findUniqueOrThrow({
      where: { id: emailJobId },
      include: { products: { orderBy: { position: "asc" } } },
    });

    if (job.attemptCount > 0) {
      return job;
    }
    if (
      job.status !== EmailJobStatus.PENDING &&
      job.status !== EmailJobStatus.PROCESSING
    ) {
      return job;
    }

    const productIds = job.products.map((p) => p.productId);
    const stillEligible = await tx.product.findMany({
      where: {
        id: { in: productIds },
        shopId: job.shopId,
        eligible: true,
        deletedAt: null,
        status: "ACTIVE",
        publishedToOnlineStore: true,
        ...(inStockOnly ? { inStock: true } : {}),
      },
    });
    const eligibleMap = new Map(stillEligible.map((p) => [p.id, p]));
    const kept = job.products.filter((p) => eligibleMap.has(p.productId));

    if (kept.length === job.products.length) {
      return job;
    }

    const need = Math.max(0, Math.min(batchSize, batchSize - kept.length));
    let replacements: SelectedProduct[] = [];
    if (need > 0) {
      replacements = await selectRandomEligibleProducts(tx, {
        shopId: job.shopId,
        subscriberId: job.subscriberId,
        cycleNumber: job.cycleNumber,
        inStockOnly,
        limit: need,
        hardExcludeIds: productIds,
      });
    }

    // Rebuild line items: kept (eligible) + replacements, re-positioned.
    const keptSelected: SelectedProduct[] = kept.map((line) => {
      const p = eligibleMap.get(line.productId)!;
      return {
        id: p.id,
        shopifyProductGid: p.shopifyProductGid,
        title: p.title,
        handle: p.handle,
        imageUrl: p.imageUrl,
        storefrontUrl: p.storefrontUrl,
        priceMin: p.priceMin,
        currencyCode: p.currencyCode,
      };
    });

    const finalProducts = dedupeSelected([
      ...keptSelected,
      ...replacements,
    ]).slice(0, batchSize);

    if (finalProducts.length === 0) {
      await tx.emailJob.update({
        where: { id: job.id },
        data: {
          status: EmailJobStatus.CANCELLED,
          lastErrorCode: "no_eligible_products",
          lastErrorMessage: "All reserved products became ineligible before send",
          completedAt: new Date(),
        },
      });
      return tx.emailJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { products: { orderBy: { position: "asc" } } },
      });
    }

    await tx.emailJobProduct.deleteMany({ where: { emailJobId: job.id } });
    const snapshot = toSnapshotItems(finalProducts);
    await tx.emailJobProduct.createMany({
      data: snapshot.map((item) => ({
        shopId: job.shopId,
        emailJobId: job.id,
        productId: item.productId,
        position: item.position,
        shopifyProductGid: item.shopifyProductGid,
        title: item.title,
        handle: item.handle,
        imageUrl: item.imageUrl,
        price: item.price,
        currencyCode: item.currencyCode,
        productUrl: item.productUrl,
      })),
    });
    await tx.emailJob.update({
      where: { id: job.id },
      data: { productSnapshot: { products: snapshot } },
    });

    return tx.emailJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { products: { orderBy: { position: "asc" } } },
    });
  });
}

function dedupeSelected(products: SelectedProduct[]): SelectedProduct[] {
  const seen = new Set<string>();
  const out: SelectedProduct[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Claim a job for processing (PENDING / RETRY_SCHEDULED → PROCESSING). */
export async function claimEmailJob(
  emailJobId: string,
  leaseOwner: string,
  leaseMs = 60_000,
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const updated = await client.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: {
        in: [EmailJobStatus.PENDING, EmailJobStatus.RETRY_SCHEDULED],
      },
    },
    data: {
      status: EmailJobStatus.PROCESSING,
      leaseOwner,
      leaseExpiresAt,
      processingStartedAt: now,
      attemptCount: { increment: 1 },
    },
  });

  if (updated.count === 0) return null;

  return client.emailJob.findUniqueOrThrow({
    where: { id: emailJobId },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

/**
 * Provider accepted the message → commit history + close job.
 */
export async function markEmailJobAccepted(
  emailJobId: string,
  options: {
    providerMessageId?: string;
    providerName?: string;
    intervalDays?: number;
    /**
     * Allow UNKNOWN → ACCEPTED only after provider status reconciliation
     * (never for blind retries).
     */
    reconcileUnknown?: boolean;
  } = {},
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts> {
  const intervalDays = options.intervalDays ?? 3;

  return client.$transaction(async (tx) => {
    const job = await tx.emailJob.findUniqueOrThrow({
      where: { id: emailJobId },
      include: { products: { orderBy: { position: "asc" } } },
    });

    if (job.status === EmailJobStatus.ACCEPTED) {
      return job;
    }
    if (job.status === EmailJobStatus.UNKNOWN && !options.reconcileUnknown) {
      throw new Error("cannot_accept_unknown_job_without_manual_resolution");
    }

    const completedAt = new Date();
    const nextEmailAt = new Date(
      completedAt.getTime() + intervalDays * 24 * 60 * 60 * 1000,
    );

    await commitProductHistoryAfterAcceptance(tx, {
      shopId: job.shopId,
      subscriberId: job.subscriberId,
      cycleNumber: job.cycleNumber,
      emailJobId: job.id,
      productIds: job.products.map((p) => p.productId),
      sentAt: completedAt,
    });

    await tx.subscriber.update({
      where: { id: job.subscriberId },
      data: {
        lastSuccessfulEmailAt: completedAt,
        nextEmailAt,
        currentCycleNumber: job.cycleNumber,
      },
    });

    return tx.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.ACCEPTED,
        completedAt,
        providerMessageId: options.providerMessageId,
        providerName: options.providerName,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      include: { products: { orderBy: { position: "asc" } } },
    });
  });
}

/**
 * Ambiguous provider timeout: mark UNKNOWN and do not resend or write history.
 */
export async function markEmailJobUnknown(
  emailJobId: string,
  error: {
    code?: string;
    message?: string;
    providerMessageId?: string;
    providerName?: string;
  },
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts> {
  return client.emailJob.update({
    where: { id: emailJobId },
    data: {
      status: EmailJobStatus.UNKNOWN,
      lastErrorCode: error.code ?? "provider_timeout",
      lastErrorMessage: error.message ?? "Ambiguous provider response",
      ...(error.providerMessageId
        ? { providerMessageId: error.providerMessageId }
        : {}),
      ...(error.providerName ? { providerName: error.providerName } : {}),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

/**
 * Schedule a retry while keeping the same reserved product batch.
 */
export async function scheduleEmailJobRetry(
  emailJobId: string,
  options: { nextRetryAt: Date; errorCode?: string; errorMessage?: string },
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts> {
  const job = await client.emailJob.findUniqueOrThrow({
    where: { id: emailJobId },
  });

  if (job.status === EmailJobStatus.UNKNOWN) {
    throw new Error("cannot_retry_unknown_job_blindly");
  }
  if (job.status === EmailJobStatus.ACCEPTED) {
    throw new Error("cannot_retry_accepted_job");
  }

  if (job.attemptCount >= job.maxAttempts) {
    return client.emailJob.update({
      where: { id: emailJobId },
      data: {
        status: EmailJobStatus.FAILED,
        completedAt: new Date(),
        lastErrorCode: options.errorCode ?? "max_attempts",
        lastErrorMessage: options.errorMessage ?? "Max attempts exceeded",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      include: { products: { orderBy: { position: "asc" } } },
    });
  }

  return client.emailJob.update({
    where: { id: emailJobId },
    data: {
      status: EmailJobStatus.RETRY_SCHEDULED,
      nextRetryAt: options.nextRetryAt,
      lastErrorCode: options.errorCode,
      lastErrorMessage: options.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

/** Load job + products for workers / tests. */
export async function getEmailJobWithProducts(
  emailJobId: string,
  client: typeof prisma = prisma,
): Promise<EmailJobWithProducts | null> {
  return client.emailJob.findUnique({
    where: { id: emailJobId },
    include: { products: { orderBy: { position: "asc" } } },
  });
}
