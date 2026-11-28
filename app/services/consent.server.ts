/**
 * Email marketing consent helpers.
 * Verified against Admin GraphQL 2026-10:
 * - Customer.defaultEmailAddress.emailAddress / marketingState
 * - Customer.emailMarketingConsent.marketingState / consentUpdatedAt
 * - customerEmailMarketingConsentUpdate (write_customers) — UNSUBSCRIBED only from app
 *
 * Never auto-resubscribe. Fail closed when consent cannot be verified.
 */
import type { Subscriber } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  EmailJobStatus,
  MarketingConsentState,
  SuppressionReason,
} from "../lib/prisma.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { adminGraphql } from "../shopify/admin-graphql.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  if (normalized.length > 254) return false;
  return EMAIL_RE.test(normalized);
}

export function parseMarketingConsentState(
  value: string | null | undefined,
): MarketingConsentState {
  switch ((value ?? "").toUpperCase()) {
    case "SUBSCRIBED":
      return MarketingConsentState.SUBSCRIBED;
    case "UNSUBSCRIBED":
      return MarketingConsentState.UNSUBSCRIBED;
    case "PENDING":
      return MarketingConsentState.PENDING;
    case "INVALID":
      return MarketingConsentState.INVALID;
    case "REDACTED":
      return MarketingConsentState.REDACTED;
    case "NOT_SUBSCRIBED":
    default:
      return MarketingConsentState.NOT_SUBSCRIBED;
  }
}

/**
 * Marketing-eligible only when explicitly SUBSCRIBED with a valid email
 * and not suppressed. Ordinary customers (NOT_SUBSCRIBED) are never eligible.
 */
export function isMarketingEligible(input: {
  email: string | null | undefined;
  marketingConsentState: MarketingConsentState | string;
  isSuppressed?: boolean;
  deleted?: boolean;
}): boolean {
  if (input.deleted) return false;
  if (input.isSuppressed) return false;
  if (!isValidEmail(input.email)) return false;
  const state =
    typeof input.marketingConsentState === "string"
      ? parseMarketingConsentState(input.marketingConsentState)
      : input.marketingConsentState;
  return state === MarketingConsentState.SUBSCRIBED;
}

export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

/** Monday + Thursday (UTC getUTCDay): two sends per week without drift. */
export const SCHEDULE_WEEKDAYS_UTC = [1, 4] as const;
export const SCHEDULE_HOUR_UTC = 14;

/**
 * Stable stagger offset in minutes so initial sends are not simultaneous.
 * Kept within a few hours on the send day (not multi-day) so new subscribers
 * are not blocked for days before their first Flow request can run.
 */
export function computeStaggerMinutes(
  shopId: string,
  shopifyCustomerGid: string,
  intervalDays: number,
): number {
  // Cap to 4h regardless of intervalDays — Mon/Thu slots own the cadence.
  const windowMinutes = Math.min(4 * 60, Math.max(intervalDays, 1) * 24 * 60);
  let hash = 0;
  const key = `${shopId}:${shopifyCustomerGid}`;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % windowMinutes;
}

/**
 * Next Mon/Thu slot after `after` (UTC).
 * When skipSameUtcDay is true (post-send), never lands on the same UTC day.
 */
export function nextScheduledSlot(options: {
  after: Date;
  weekdays?: readonly number[];
  hourUtc?: number;
  minuteUtc?: number;
  skipSameUtcDay?: boolean;
}): Date {
  const weekdays = options.weekdays ?? SCHEDULE_WEEKDAYS_UTC;
  const hourUtc = options.hourUtc ?? SCHEDULE_HOUR_UTC;
  const minuteUtc = options.minuteUtc ?? 0;
  const after = options.after;
  const startDayOffset = options.skipSameUtcDay ? 1 : 0;

  for (let dayOffset = startDayOffset; dayOffset <= 14; dayOffset++) {
    const candidate = new Date(
      Date.UTC(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate() + dayOffset,
        hourUtc,
        minuteUtc,
        0,
        0,
      ),
    );
    if (
      weekdays.includes(candidate.getUTCDay()) &&
      candidate.getTime() > after.getTime()
    ) {
      return candidate;
    }
  }

  return new Date(after.getTime() + 3 * 24 * 60 * 60 * 1000);
}

/**
 * Independent next-email schedule for a subscriber (UTC Mon/Thu).
 * intervalDays is retained for stagger window sizing / settings UI only.
 */
export function calculateNextEmailAt(options: {
  shopId: string;
  shopifyCustomerGid: string;
  intervalDays: number;
  lastSuccessfulEmailAt?: Date | null;
  now?: Date;
  /** When true, assign staggered first-send instead of immediate. */
  staggerInitial?: boolean;
}): Date {
  const now = options.now ?? new Date();

  if (options.lastSuccessfulEmailAt) {
    return nextScheduledSlot({
      after: options.lastSuccessfulEmailAt,
      skipSameUtcDay: true,
    });
  }

  const staggerMinutes =
    options.staggerInitial !== false
      ? computeStaggerMinutes(
          options.shopId,
          options.shopifyCustomerGid,
          options.intervalDays,
        )
      : 0;

  return nextScheduledSlot({
    after: now,
    minuteUtc: staggerMinutes,
    skipSameUtcDay: false,
  });
}

export type LiveConsentResult =
  | {
      ok: true;
      email: string;
      marketingState: MarketingConsentState;
      consentUpdatedAt: Date | null;
    }
  | { ok: false; reason: string };

/**
 * Live Shopify consent check. Fail closed on any uncertainty.
 */
export async function verifyConsentBeforeSend(
  client: AdminGraphqlClient,
  shopDomain: string,
  shopifyCustomerGid: string,
): Promise<LiveConsentResult> {
  try {
    const { data } = await adminGraphql<{
      customer: {
        id: string;
        defaultEmailAddress: {
          emailAddress: string | null;
          marketingState: string | null;
        } | null;
        emailMarketingConsent: {
          marketingState: string;
          consentUpdatedAt: string | null;
        } | null;
      } | null;
    }>(
      client,
      `#graphql
        query SmartMailerVerifyConsent($id: ID!) {
          customer(id: $id) {
            id
            defaultEmailAddress {
              emailAddress
              marketingState
            }
            emailMarketingConsent {
              marketingState
              consentUpdatedAt
            }
          }
        }`,
      { shop: shopDomain, variables: { id: shopifyCustomerGid } },
    );

    if (!data.customer) {
      return { ok: false, reason: "customer_not_found" };
    }

    const email =
      data.customer.defaultEmailAddress?.emailAddress?.trim() ?? null;
    if (!isValidEmail(email)) {
      return { ok: false, reason: "invalid_or_missing_email" };
    }

    // Prefer emailMarketingConsent when present; fall back to defaultEmailAddress.
    const rawState =
      data.customer.emailMarketingConsent?.marketingState ??
      data.customer.defaultEmailAddress?.marketingState ??
      null;

    if (!rawState) {
      return { ok: false, reason: "consent_state_unavailable" };
    }

    const marketingState = parseMarketingConsentState(rawState);
    if (marketingState !== MarketingConsentState.SUBSCRIBED) {
      return { ok: false, reason: `consent_${marketingState.toLowerCase()}` };
    }

    const consentUpdatedAt = data.customer.emailMarketingConsent
      ?.consentUpdatedAt
      ? new Date(data.customer.emailMarketingConsent.consentUpdatedAt)
      : null;

    return {
      ok: true,
      email: normalizeEmail(email!),
      marketingState,
      consentUpdatedAt,
    };
  } catch (error) {
    logger.warn("consent_verify_failed_closed", {
      shop: shopDomain,
      name: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "consent_verification_error" };
  }
}

/**
 * Cancel pending / retry / processing email jobs for a subscriber.
 */
export async function cancelPendingJobsForSubscriber(
  shopId: string,
  subscriberId: string,
  reason: string,
): Promise<number> {
  const result = await prisma.emailJob.updateMany({
    where: {
      shopId,
      subscriberId,
      status: {
        in: [
          EmailJobStatus.PENDING,
          EmailJobStatus.PROCESSING,
          EmailJobStatus.RETRY_SCHEDULED,
        ],
      },
    },
    data: {
      status: EmailJobStatus.CANCELLED,
      completedAt: new Date(),
      lastErrorCode: "consent_revoked",
      lastErrorMessage: reason.slice(0, 500),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  return result.count;
}

/**
 * Record a suppression and mark the subscriber ineligible.
 * Does not lift other reasons automatically.
 */
export async function applySuppression(options: {
  shopId: string;
  subscriberId?: string | null;
  emailNormalized: string;
  reason: SuppressionReason;
  source?: string;
  notes?: string;
}): Promise<void> {
  const emailNormalized = normalizeEmail(options.emailNormalized);

  await prisma.suppression.upsert({
    where: {
      shopId_emailNormalized_reason: {
        shopId: options.shopId,
        emailNormalized,
        reason: options.reason,
      },
    },
    create: {
      shopId: options.shopId,
      subscriberId: options.subscriberId ?? null,
      emailNormalized,
      reason: options.reason,
      source: options.source ?? "system",
      notes: options.notes,
      active: true,
    },
    update: {
      subscriberId: options.subscriberId ?? undefined,
      active: true,
      liftedAt: null,
      source: options.source ?? "system",
      notes: options.notes,
    },
  });

  if (options.subscriberId) {
    await prisma.subscriber.update({
      where: { id: options.subscriberId },
      data: {
        isSuppressed: true,
        eligible: false,
        nextEmailAt: null,
      },
    });
    await cancelPendingJobsForSubscriber(
      options.shopId,
      options.subscriberId,
      `suppressed:${options.reason}`,
    );
  } else {
    await prisma.subscriber.updateMany({
      where: { shopId: options.shopId, emailNormalized },
      data: {
        isSuppressed: true,
        eligible: false,
        nextEmailAt: null,
      },
    });
  }
}

export async function hasActiveSuppression(
  shopId: string,
  emailNormalized: string,
): Promise<boolean> {
  const count = await prisma.suppression.count({
    where: {
      shopId,
      emailNormalized: normalizeEmail(emailNormalized),
      active: true,
    },
  });
  return count > 0;
}

/**
 * Push an external (ESP) unsubscribe to Shopify as UNSUBSCRIBED.
 * Never sends SUBSCRIBED — we never auto-resubscribe.
 */
export async function syncUnsubscribeToShopify(
  client: AdminGraphqlClient,
  shopDomain: string,
  shopifyCustomerGid: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const { data } = await adminGraphql<{
    customerEmailMarketingConsentUpdate: {
      customer: { id: string } | null;
      userErrors: { message: string; field?: string[] | null }[];
    };
  }>(
    client,
    `#graphql
      mutation SmartMailerUnsubscribe($input: CustomerEmailMarketingConsentUpdateInput!) {
        customerEmailMarketingConsentUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
    {
      shop: shopDomain,
      variables: {
        input: {
          customerId: shopifyCustomerGid,
          emailMarketingConsent: {
            marketingState: "UNSUBSCRIBED",
            consentUpdatedAt: new Date().toISOString(),
          },
        },
      },
    },
  );

  const errors =
    data.customerEmailMarketingConsentUpdate.userErrors.map((e) => e.message) ??
    [];
  return {
    ok: errors.length === 0 && Boolean(data.customerEmailMarketingConsentUpdate.customer),
    errors,
  };
}

/**
 * Handle local unsubscribe: suppress, cancel jobs, mark UNSUBSCRIBED, sync to Shopify.
 */
export async function handleExternalUnsubscribe(options: {
  shopId: string;
  shopDomain: string;
  subscriber: Subscriber;
  client: AdminGraphqlClient;
  source: string;
}): Promise<void> {
  await applySuppression({
    shopId: options.shopId,
    subscriberId: options.subscriber.id,
    emailNormalized: options.subscriber.emailNormalized,
    reason: SuppressionReason.UNSUBSCRIBED,
    source: options.source,
  });

  await prisma.subscriber.update({
    where: { id: options.subscriber.id },
    data: {
      marketingConsentState: MarketingConsentState.UNSUBSCRIBED,
      eligible: false,
      isSuppressed: true,
      nextEmailAt: null,
      consentUpdatedAt: new Date(),
    },
  });

  const result = await syncUnsubscribeToShopify(
    options.client,
    options.shopDomain,
    options.subscriber.shopifyCustomerGid,
  );

  if (!result.ok) {
    logger.warn("shopify_unsubscribe_sync_failed", {
      shop: options.shopDomain,
      errorCount: result.errors.length,
    });
  }
}

/**
 * Apply a Shopify consent change discovered via sync/webhook.
 * Never upgrades local state to SUBSCRIBED via ESP — only from Shopify sync.
 */
export async function applyShopifyConsentChange(options: {
  shopId: string;
  subscriberId: string;
  emailNormalized: string;
  marketingState: MarketingConsentState;
  consentUpdatedAt?: Date | null;
}): Promise<void> {
  const subscribed = options.marketingState === MarketingConsentState.SUBSCRIBED;

  if (!subscribed) {
    await cancelPendingJobsForSubscriber(
      options.shopId,
      options.subscriberId,
      `shopify_consent_${options.marketingState}`,
    );

    if (
      options.marketingState === MarketingConsentState.UNSUBSCRIBED ||
      options.marketingState === MarketingConsentState.REDACTED ||
      options.marketingState === MarketingConsentState.INVALID
    ) {
      const reason =
        options.marketingState === MarketingConsentState.UNSUBSCRIBED
          ? SuppressionReason.UNSUBSCRIBED
          : options.marketingState === MarketingConsentState.REDACTED
            ? SuppressionReason.REDACTED
            : SuppressionReason.INVALID_EMAIL;

      await applySuppression({
        shopId: options.shopId,
        subscriberId: options.subscriberId,
        emailNormalized: options.emailNormalized,
        reason,
        source: "shopify",
      });
    }
  }

  await prisma.subscriber.update({
    where: { id: options.subscriberId },
    data: {
      marketingConsentState: options.marketingState,
      consentUpdatedAt: options.consentUpdatedAt ?? new Date(),
      // Eligibility recomputed by caller with suppression + email checks.
    },
  });
}
