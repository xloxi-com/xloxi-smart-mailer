/**
 * Merchant-safe error messages for the admin UI.
 * Never expose Prisma args, SQL, tokens, emails, or stack traces.
 */

const PRISMA_PATTERNS: Array<{ match: RegExp; message: string }> = [
  {
    match: /Unknown argument/i,
    message:
      "Catalog sync is out of date with the database schema. Restart the app after migrations, then sync again.",
  },
  {
    match: /column .* does not exist/i,
    message:
      "A required database column is missing. Apply pending migrations, then sync again.",
  },
  {
    match: /Unique constraint|P2002/i,
    message: "A duplicate record blocked this operation.",
  },
  {
    match: /Record to (update|delete) does not exist|P2025/i,
    message: "The requested record was not found.",
  },
  {
    match: /Timed out|timeout/i,
    message: "The operation timed out. Try again in a moment.",
  },
  {
    match: /Can't reach database|P1001|P1017/i,
    message: "Could not reach the database. Check connectivity and try again.",
  },
];

export function toMerchantSafeError(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!raw) return fallback;

  for (const { match, message } of PRISMA_PATTERNS) {
    if (match.test(raw)) return message;
  }

  // Known app-level codes (snake_case) are safe to surface.
  if (/^[a-z][a-z0-9_]{2,80}$/i.test(raw) && !raw.includes(" ")) {
    return raw.replace(/_/g, " ");
  }

  if (raw.length <= 120 && !/prisma|select |insert |update |password|token|secret/i.test(raw)) {
    return raw;
  }

  return fallback;
}

export function sanitizeSyncPartialErrors(errors: string[]): string[] {
  return errors
    .map((e) => toMerchantSafeError(e, "Sync item failed"))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(-10);
}
