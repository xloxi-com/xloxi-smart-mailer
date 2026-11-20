/**
 * Shared enum mirrors for route UI (safe in client + SSR).
 * Keep values aligned with prisma/schema.prisma — server code should prefer
 * runtime enums from `./prisma.server` when writing to the database.
 */
export const MarketingConsentState = {
  SUBSCRIBED: "SUBSCRIBED",
  UNSUBSCRIBED: "UNSUBSCRIBED",
  NOT_SUBSCRIBED: "NOT_SUBSCRIBED",
  PENDING: "PENDING",
  INVALID: "INVALID",
  REDACTED: "REDACTED",
} as const;

export type MarketingConsentStateValue =
  (typeof MarketingConsentState)[keyof typeof MarketingConsentState];

export const EmailJobStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  ACCEPTED: "ACCEPTED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
} as const;

export type EmailJobStatusValue =
  (typeof EmailJobStatus)[keyof typeof EmailJobStatus];
