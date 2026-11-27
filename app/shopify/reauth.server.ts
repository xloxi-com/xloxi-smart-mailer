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
  const granted = new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // Shopify: a write_* grant includes the matching read_* permission.
  for (const handle of [...granted]) {
    if (handle.startsWith("write_")) {
      granted.add(`read_${handle.slice("write_".length)}`);
    }
  }
  return granted;
}

export function getMissingRequiredScopes(
  scope: string | undefined | null,
): string[] {
  const granted = parseGrantedScopes(scope);
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

/** Store handle for admin.shopify.com/store/{handle}/... URLs. */
export function shopHandleFromDomain(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "").trim();
}

/**
 * Correct install / scope-update URL (never use https://{shop}.myshopify.com/... —
 * that endpoint returns null).
 */
export function buildScopeUpdateUrl(options: {
  shopDomain: string;
  clientId: string;
  optionalScopes?: string[];
}): string | null {
  const clientId = options.clientId.trim();
  if (!clientId) return null;
  const handle = shopHandleFromDomain(options.shopDomain);
  if (!handle) return null;
  const url = new URL(
    `https://admin.shopify.com/store/${encodeURIComponent(handle)}/oauth/install`,
  );
  url.searchParams.set("client_id", clientId);
  if (options.optionalScopes && options.optionalScopes.length > 0) {
    url.searchParams.set("optional_scopes", options.optionalScopes.join(","));
  }
  return url.toString();
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
