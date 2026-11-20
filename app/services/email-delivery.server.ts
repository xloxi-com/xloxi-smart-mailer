/**
 * Marketing email delivery orchestration (provider-independent).
 * Never sends when disabled / suppressed / not allowlisted.
 * Reconciles ambiguous results before retry; records events idempotently.
 */
import type { EmailJob, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { getShopifyAppEnv } from "../lib/env.server";
import {
  EmailEventType,
  EmailJobStatus,
  MarketingConsentState,
  SuppressionReason,
} from "../lib/prisma.server";
import {
  hasActiveSuppression,
  isMarketingEligible,
  isValidEmail,
  normalizeEmail,
  applySuppression,
} from "./consent.server";
import {
  claimEmailJob,
  markEmailJobAccepted,
  markEmailJobUnknown,
  scheduleEmailJobRetry,
  type EmailJobWithProducts,
} from "./email-reservation.server";
import {
  computeEmailBackoffMs,
  getEmailProvider,
  isEmailSendingEnabled,
  isRecipientAllowed,
  type DeliveryEvent,
  type EmailProvider,
  type SendResult,
} from "./email-provider.server";
import {
  buildListUnsubscribeHeaders,
  buildSignedUnsubscribeUrl,
} from "./unsubscribe.server";

export type DeliverMarketingEmailInput = {
  emailJobId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  shopDomain: string;
  leaseOwner?: string;
  /** Force a provider (tests). */
  provider?: EmailProvider;
  intervalDays?: number;
  /**
   * When the worker already claimed the job via SKIP LOCKED,
   * pass it here to avoid a second claim.
   */
  alreadyClaimedJob?: EmailJobWithProducts;
};

export type DeliverResult =
  | {
      status: "accepted" | "dry_run" | "skipped" | "failed" | "retry_scheduled" | "unknown";
      emailJobId: string;
      providerName?: string;
      providerMessageId?: string;
      reason?: string;
    };

async function recordEvent(options: {
  shopId: string;
  emailJobId?: string | null;
  subscriberId?: string | null;
  type: EmailEventType;
  providerEventId?: string | null;
  providerMessageId?: string | null;
  payload?: Prisma.InputJsonValue;
  occurredAt?: Date;
}): Promise<boolean> {
  try {
    await prisma.emailEvent.create({
      data: {
        shopId: options.shopId,
        emailJobId: options.emailJobId ?? null,
        subscriberId: options.subscriberId ?? null,
        type: options.type,
        providerEventId: options.providerEventId ?? null,
        providerMessageId: options.providerMessageId ?? null,
        payload: options.payload,
        occurredAt: options.occurredAt ?? new Date(),
      },
    });
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "";
    if (code === "P2002") return false; // idempotent duplicate providerEventId
    throw error;
  }
}

function mapDeliveryEventType(type: DeliveryEvent["type"]): EmailEventType {
  switch (type) {
    case "accepted":
      return EmailEventType.SENT;
    case "delivered":
      return EmailEventType.DELIVERED;
    case "bounced":
      return EmailEventType.BOUNCED;
    case "complained":
      return EmailEventType.COMPLAINED;
    case "unsubscribed":
      return EmailEventType.UNSUBSCRIBED;
    case "failed":
    default:
      return EmailEventType.FAILED;
  }
}

/**
 * Deterministic idempotency key for a marketing job (already unique on EmailJob).
 */
export function marketingIdempotencyKey(job: Pick<EmailJob, "idempotencyKey">): string {
  return job.idempotencyKey;
}

async function assertSendable(options: {
  shopId: string;
  subscriberId: string;
  to: string;
  dryRun: boolean;
}): Promise<{ ok: true; emailNormalized: string } | { ok: false; reason: string }> {
  const emailNormalized = normalizeEmail(options.to);
  if (!isValidEmail(emailNormalized)) {
    return { ok: false, reason: "invalid_email" };
  }

  if (await hasActiveSuppression(options.shopId, emailNormalized)) {
    return { ok: false, reason: "suppressed" };
  }

  const subscriber = await prisma.subscriber.findUnique({
    where: { id: options.subscriberId },
  });
  if (!subscriber || subscriber.deletedAt) {
    return { ok: false, reason: "subscriber_missing" };
  }
  if (
    !isMarketingEligible({
      email: subscriber.email,
      marketingConsentState: subscriber.marketingConsentState,
      isSuppressed: subscriber.isSuppressed,
      deleted: Boolean(subscriber.deletedAt),
    })
  ) {
    return { ok: false, reason: "not_marketing_eligible" };
  }

  // Live path must pass allowlist; dry-run / disabled sending always allowed for simulation.
  if (isEmailSendingEnabled() && !options.dryRun && !isRecipientAllowed(emailNormalized)) {
    return { ok: false, reason: "not_on_test_allowlist" };
  }

  return { ok: true, emailNormalized };
}

/**
 * Deliver (or dry-run) a reserved marketing email job.
 */
export async function deliverMarketingEmail(
  input: DeliverMarketingEmailInput,
): Promise<DeliverResult> {
  const provider = input.provider ?? getEmailProvider();
  const leaseOwner = input.leaseOwner ?? `delivery:${provider.name}`;

  let job: EmailJobWithProducts | null = input.alreadyClaimedJob ?? null;
  if (!job) {
    job = await claimEmailJob(input.emailJobId, leaseOwner);
  }
  if (!job) {
    const existing = await prisma.emailJob.findUnique({
      where: { id: input.emailJobId },
    });
    if (existing?.status === EmailJobStatus.ACCEPTED) {
      return {
        status: "accepted",
        emailJobId: input.emailJobId,
        providerMessageId: existing.providerMessageId ?? undefined,
        providerName: existing.providerName ?? undefined,
        reason: "already_accepted",
      };
    }
    if (existing?.status === EmailJobStatus.UNKNOWN) {
      return {
        status: "unknown",
        emailJobId: input.emailJobId,
        reason: "ambiguous_pending_reconcile",
      };
    }
    return {
      status: "skipped",
      emailJobId: input.emailJobId,
      reason: "not_claimable",
    };
  }

  if (!input.alreadyClaimedJob) {
    await recordEvent({
      shopId: job.shopId,
      emailJobId: job.id,
      subscriberId: job.subscriberId,
      type: EmailEventType.CLAIMED,
    });
  }

  const gate = await assertSendable({
    shopId: job.shopId,
    subscriberId: job.subscriberId,
    to: input.to,
    dryRun: job.dryRun || !isEmailSendingEnabled(),
  });

  if (!gate.ok) {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
        lastErrorCode: gate.reason,
        lastErrorMessage: `send_blocked:${gate.reason}`,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await recordEvent({
      shopId: job.shopId,
      emailJobId: job.id,
      subscriberId: job.subscriberId,
      type: EmailEventType.CANCELLED,
      payload: { reason: gate.reason },
    });
    return { status: "skipped", emailJobId: job.id, reason: gate.reason };
  }

  const appUrl = getShopifyAppEnv().SHOPIFY_APP_URL || "https://example.com";
  const unsubscribeUrl = buildSignedUnsubscribeUrl({
    appUrl,
    shopId: job.shopId,
    subscriberId: job.subscriberId,
    emailNormalized: gate.emailNormalized,
  });
  const listHeaders = buildListUnsubscribeHeaders(unsubscribeUrl);

  const sendResult = await provider.sendMarketingEmail({
    to: gate.emailNormalized,
    subject: input.subject,
    html: input.html,
    text: input.text,
    idempotencyKey: marketingIdempotencyKey(job),
    unsubscribeUrl,
    listUnsubscribeUrl: unsubscribeUrl,
    headers: listHeaders,
    tags: {
      emailJobId: job.id,
      shopDomain: input.shopDomain,
    },
    shopDomain: input.shopDomain,
    emailJobId: job.id,
  });

  return finalizeSendResult({
    job,
    sendResult,
    providerName: provider.name,
    provider,
    intervalDays: input.intervalDays,
  });
}

async function finalizeSendResult(options: {
  job: EmailJobWithProducts;
  sendResult: SendResult;
  providerName: string;
  provider: EmailProvider;
  intervalDays?: number;
}): Promise<DeliverResult> {
  const { job, sendResult, providerName, provider } = options;

  if (sendResult.status === "accepted" && sendResult.providerMessageId) {
    await markEmailJobAccepted(job.id, {
      providerMessageId: sendResult.providerMessageId,
      providerName,
      intervalDays: options.intervalDays,
    });
    await recordEvent({
      shopId: job.shopId,
      emailJobId: job.id,
      subscriberId: job.subscriberId,
      type: EmailEventType.SENT,
      providerMessageId: sendResult.providerMessageId,
      providerEventId: `accepted:${sendResult.providerMessageId}`,
    });
    return {
      status: providerName === "dry_run" ? "dry_run" : "accepted",
      emailJobId: job.id,
      providerName,
      providerMessageId: sendResult.providerMessageId,
    };
  }

  if (sendResult.status === "ambiguous" || sendResult.errorCode === "timeout") {
    // Reconcile before any blind retry.
    if (sendResult.providerMessageId) {
      const status = await provider.getMessageStatus(sendResult.providerMessageId);
      if (status.state === "accepted" || status.state === "delivered") {
        await markEmailJobAccepted(job.id, {
          providerMessageId: sendResult.providerMessageId,
          providerName,
          intervalDays: options.intervalDays,
          reconcileUnknown: true,
        });
        await recordEvent({
          shopId: job.shopId,
          emailJobId: job.id,
          subscriberId: job.subscriberId,
          type: EmailEventType.SENT,
          providerMessageId: sendResult.providerMessageId,
          providerEventId: `reconciled:${sendResult.providerMessageId}`,
        });
        return {
          status: "accepted",
          emailJobId: job.id,
          providerName,
          providerMessageId: sendResult.providerMessageId,
          reason: "reconciled_after_ambiguous",
        };
      }
    }

    await markEmailJobUnknown(job.id, {
      code: sendResult.errorCode ?? "ambiguous",
      message: sendResult.errorMessage ?? "Ambiguous provider response",
      providerMessageId: sendResult.providerMessageId,
      providerName,
    });
    await recordEvent({
      shopId: job.shopId,
      emailJobId: job.id,
      subscriberId: job.subscriberId,
      type: EmailEventType.FAILED,
      payload: { ambiguous: true },
    });
    return {
      status: "unknown",
      emailJobId: job.id,
      providerName,
      reason: "ambiguous_no_blind_retry",
    };
  }

  if (sendResult.retryable) {
    const backoff =
      sendResult.retryAfterMs ?? computeEmailBackoffMs(job.attemptCount);
    await scheduleEmailJobRetry(job.id, {
      nextRetryAt: new Date(Date.now() + backoff),
      errorCode: sendResult.errorCode ?? sendResult.status,
      errorMessage: sendResult.errorMessage ?? "retryable_provider_error",
    });
    await recordEvent({
      shopId: job.shopId,
      emailJobId: job.id,
      subscriberId: job.subscriberId,
      type: EmailEventType.RETRY,
      payload: { backoffMs: backoff, status: sendResult.status },
    });
    return {
      status: "retry_scheduled",
      emailJobId: job.id,
      providerName,
      reason: sendResult.errorCode,
    };
  }

  await prisma.emailJob.update({
    where: { id: job.id },
    data: {
      status: EmailJobStatus.FAILED,
      completedAt: new Date(),
      lastErrorCode: sendResult.errorCode ?? "rejected",
      lastErrorMessage: sendResult.errorMessage?.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      providerName,
    },
  });
  await recordEvent({
    shopId: job.shopId,
    emailJobId: job.id,
    subscriberId: job.subscriberId,
    type: EmailEventType.FAILED,
    payload: { errorCode: sendResult.errorCode },
  });
  return {
    status: "failed",
    emailJobId: job.id,
    providerName,
    reason: sendResult.errorCode,
  };
}

/**
 * Apply provider delivery webhooks idempotently (unique providerEventId).
 */
export async function applyProviderDeliveryEvents(
  shopId: string,
  events: DeliveryEvent[],
): Promise<{ applied: number; duplicates: number }> {
  let applied = 0;
  let duplicates = 0;

  for (const event of events) {
    const job = event.providerMessageId
      ? await prisma.emailJob.findFirst({
          where: { shopId, providerMessageId: event.providerMessageId },
        })
      : null;

    const created = await recordEvent({
      shopId,
      emailJobId: job?.id,
      subscriberId: job?.subscriberId,
      type: mapDeliveryEventType(event.type),
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      payload: event.safeMeta as Prisma.InputJsonValue | undefined,
      occurredAt: event.occurredAt,
    });

    if (!created) {
      duplicates += 1;
      continue;
    }
    applied += 1;

    if (event.type === "bounced" || event.type === "complained") {
      // Only suppress when bound to a known job — never trust unbound email hints.
      if (!job) continue;
      const sub = await prisma.subscriber.findUnique({
        where: { id: job.subscriberId },
        select: { emailNormalized: true },
      });
      const emailNormalized = sub?.emailNormalized ?? null;
      if (
        event.emailNormalizedHint &&
        emailNormalized &&
        normalizeEmail(event.emailNormalizedHint) !== emailNormalized
      ) {
        continue;
      }

      if (emailNormalized) {
        await applySuppression({
          shopId,
          subscriberId: job.subscriberId,
          emailNormalized,
          reason:
            event.type === "bounced"
              ? SuppressionReason.BOUNCED
              : SuppressionReason.COMPLAINED,
          source: "provider_webhook",
        });
      }
    }

    if (event.type === "unsubscribed" && job) {
      const sub = await prisma.subscriber.findUnique({
        where: { id: job.subscriberId },
        select: { emailNormalized: true },
      });
      if (sub?.emailNormalized) {
        await applySuppression({
          shopId,
          subscriberId: job.subscriberId,
          emailNormalized: sub.emailNormalized,
          reason: SuppressionReason.UNSUBSCRIBED,
          source: "provider_webhook",
        });
        await prisma.subscriber.update({
          where: { id: job.subscriberId },
          data: {
            marketingConsentState: MarketingConsentState.UNSUBSCRIBED,
            eligible: false,
            isSuppressed: true,
            nextEmailAt: null,
          },
        });
      }
    }
  }

  logger.info("provider_delivery_events_applied", {
    shopId,
    applied,
    duplicates,
  });

  return { applied, duplicates };
}

/**
 * Before retrying an UNKNOWN job, ask the provider for definitive status.
 */
export async function reconcileUnknownEmailJob(
  emailJobId: string,
  provider: EmailProvider = getEmailProvider(),
): Promise<DeliverResult> {
  const job = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { products: true },
  });
  if (!job) {
    return { status: "skipped", emailJobId, reason: "missing_job" };
  }
  if (job.status !== EmailJobStatus.UNKNOWN) {
    return {
      status: "skipped",
      emailJobId,
      reason: `status_${job.status}`,
    };
  }
  if (!job.providerMessageId) {
    return {
      status: "unknown",
      emailJobId,
      reason: "no_provider_message_id",
    };
  }

  const status = await provider.getMessageStatus(job.providerMessageId);
  if (status.state === "accepted" || status.state === "delivered") {
    await markEmailJobAccepted(job.id, {
      providerMessageId: job.providerMessageId,
      providerName: provider.name,
      reconcileUnknown: true,
    });
    return {
      status: "accepted",
      emailJobId: job.id,
      providerMessageId: job.providerMessageId,
      providerName: provider.name,
      reason: "reconciled",
    };
  }
  if (status.state === "failed" || status.state === "bounced") {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.FAILED,
        completedAt: new Date(),
        lastErrorCode: status.state,
        lastErrorMessage: status.detail ?? status.state,
      },
    });
    return { status: "failed", emailJobId: job.id, reason: status.state };
  }

  return {
    status: "unknown",
    emailJobId: job.id,
    reason: "still_ambiguous",
  };
}
