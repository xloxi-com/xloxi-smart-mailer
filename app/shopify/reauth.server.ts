import { REQUIRED_SCOPES } from "../lib/env.server";
import { logger } from "../lib/logging.server";

/**
 * App Bridge / React Router signal that the embedded admin session must be
 * re-authorized (token exchange / OAuth). Fetcher and document requests both
 * understand this 401 + header combination.
 *
 * Use only for actual revoked/expired API tokens — not for missing scopes.
 * Token exchange will not show a consent screen for new scopes, so invalidating
 * on scope drift causes an infinite reauth loop.
 */
export function reauthorizationResponse(shop?: string): Response {
  const headers = new Headers({
    "X-Shopify-Retry-Invalid-Session-Request": "1",
  });
  if (shop) {
    headers.set(
      "X-Shopify-API-Request-Failure-Reauthorize-Url",
      `/auth?shop=${encodeURIComponent(shop)}`,
    );
  }
  return new Response(undefined, {
    status: 401,
    statusText: "Unauthorized",
    headers,
  });
}

export function parseGrantedScopes(scope: string | undefined | null): Set<string> {
  if (!scope) return new Set();
  return new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function getMissingRequiredScopes(
  scope: string | undefined | null,
): string[] {
  const granted = parseGrantedScopes(scope);
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

/**
 * Soft check only. Scope upgrades need a merchant consent screen (install /
 * app version approval), which Retry-Invalid-Session cannot trigger.
 */
export function warnIfSessionMissingScopes(options: {
  shop: string;
  scope: string | undefined | null;
}): string[] {
  const missing = getMissingRequiredScopes(options.scope);
  if (missing.length > 0) {
    logger.warn("shop_session_missing_scopes", {
      shop: options.shop,
      missing,
    });
  }
  return missing;
}
