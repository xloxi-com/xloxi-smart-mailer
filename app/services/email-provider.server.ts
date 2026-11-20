/**
 * Legacy provider interface — XLOXI Smart Mailer does NOT send email.
 *
 * Delivery is exclusively via Shopify Messaging (merchant-configured Flow).
 * These adapters remain only for historical tests / dry-run stubs.
 * getEmailProvider() always returns dry-run; live ESP paths are disabled.
 */
import { createDryRunEmailProvider } from "../providers/dry-run.server";
import { createMockEmailProvider } from "../providers/mock.server";
import { createUnapprovedEmailProvider } from "../providers/unapproved.server";
import { getShopifyAppEnv } from "../lib/env.server";
import { logger } from "../lib/logging.server";

export type SendMarketingEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Deterministic per EmailJob (shop-scoped unique). */
  idempotencyKey: string;
  unsubscribeUrl: string;
  /** RFC 8058 one-click endpoint when available. */
  listUnsubscribeUrl?: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  shopDomain: string;
  emailJobId: string;
};

export type SendResultStatus =
  | "accepted"
  | "rejected"
  | "rate_limited"
  | "ambiguous";

export type SendResult = {
  status: SendResultStatus;
  providerMessageId?: string;
  retryable: boolean;
  errorCode?: string;
  errorMessage?: string;
  /** Hint for backoff (ms). */
  retryAfterMs?: number;
};

export type ProviderMessageState =
  | "queued"
  | "accepted"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "unknown";

export type MessageStatus = {
  providerMessageId: string;
  state: ProviderMessageState;
  detail?: string;
};

export type DeliveryEventType =
  | "accepted"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "unsubscribed";

export type DeliveryEvent = {
  providerEventId: string;
  providerMessageId?: string;
  type: DeliveryEventType;
  occurredAt: Date;
  /** PII-free metadata only. */
  safeMeta?: Record<string, unknown>;
  emailNormalizedHint?: string;
};

export type SuppressionSyncItem = {
  emailNormalized: string;
  reason: "unsubscribed" | "bounced" | "complained" | "manual";
  active: boolean;
};

export interface EmailProvider {
  readonly name: string;
  sendMarketingEmail(input: SendMarketingEmailInput): Promise<SendResult>;
  getMessageStatus(providerMessageId: string): Promise<MessageStatus>;
  verifyWebhook(request: Request): Promise<{ ok: boolean; reason?: string }>;
  processDeliveryEvent(request: Request): Promise<DeliveryEvent[]>;
  synchronizeSuppression(options: {
    shopDomain: string;
    items: SuppressionSyncItem[];
  }): Promise<{ synced: number }>;
}

export type EmailProviderKind = "mock" | "dry_run" | "unapproved" | "none";

/** Always false — app never sends marketing email directly. */
export function isEmailSendingEnabled(): boolean {
  void getShopifyAppEnv();
  return false;
}

export function isEmailProviderApproved(): boolean {
  return process.env.EMAIL_PROVIDER_APPROVED === "true";
}

export function getConfiguredProviderKind(): string {
  return (process.env.EMAIL_PROVIDER ?? "dry_run").trim().toLowerCase();
}

/**
 * Test-recipient allowlist. When live sending is enabled, only these addresses
 * may receive mail unless NODE_ENV=production AND allowlist empty is explicitly
 * opted into via EMAIL_ALLOWLIST_DISABLED=true (still requires approval flags).
 */
export function getTestRecipientAllowlist(): Set<string> {
  const raw = process.env.EMAIL_TEST_ALLOWLIST?.trim() ?? "";
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isRecipientAllowed(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!isEmailSendingEnabled()) {
    // Dry-run / mock path — allow any for simulation.
    return true;
  }
  const allowlist = getTestRecipientAllowlist();
  if (allowlist.size > 0) {
    return allowlist.has(normalized);
  }
  if (process.env.EMAIL_ALLOWLIST_DISABLED === "true" && isEmailProviderApproved()) {
    return true;
  }
  // Fail closed: live sending without allowlist (or production opt-out) blocks.
  return false;
}

/**
 * Resolve the active provider. Live ESP adapters are not registered until a
 * compatible provider is selected, documented for the merchant category, and
 * EMAIL_PROVIDER_APPROVED=true.
 */
export function getEmailProvider(options?: {
  forceKind?: EmailProviderKind;
}): EmailProvider {
  const kind = options?.forceKind ?? "dry_run";
  // Messaging-only architecture: never call external ESPs from this app.
  if (kind === "mock") {
    return createMockEmailProvider();
  }
  logger.info("email_provider_disabled_use_shopify_messaging", { kind });
  void createUnapprovedEmailProvider;
  void isEmailProviderApproved;
  return createDryRunEmailProvider();
}

/** Exponential backoff with jitter. Caps at 1 hour. */
export function computeEmailBackoffMs(attemptCount: number): number {
  const base = Math.min(3_600_000, 1_000 * 2 ** Math.min(attemptCount, 10));
  const jitter = Math.floor(Math.random() * Math.min(1_000, base * 0.1));
  return base + jitter;
}

export function isRetryableSendResult(result: SendResult): boolean {
  if (!result.retryable) return false;
  return (
    result.status === "rate_limited" ||
    result.status === "ambiguous" ||
    result.status === "rejected"
  );
}
