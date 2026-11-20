/**
 * Shop domain validation. Never trust a shop string from an unauthenticated
 * request for privileged work — only use shops proven by:
 * - authenticate.admin / authenticate.webhook session
 * - an offline Session row loaded from Prisma after format validation
 */

const MYSHOPIFY_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export class InvalidShopDomainError extends Error {
  constructor(message = "Invalid shop domain") {
    super(message);
    this.name = "InvalidShopDomainError";
  }
}

/**
 * Normalize and validate a shop hostname.
 * Accepts `store.myshopify.com` or URLs containing that host.
 * Rejects arbitrary domains unless they match an allowlisted custom domain.
 */
export function normalizeShopDomain(
  input: string | null | undefined,
  options?: { customShopDomains?: string[] },
): string {
  if (!input || typeof input !== "string") {
    throw new InvalidShopDomainError("Shop domain is required");
  }

  let value = input.trim().toLowerCase();

  try {
    if (value.includes("://")) {
      value = new URL(value).hostname;
    } else if (value.includes("/")) {
      value = value.split("/")[0]!;
    }
  } catch {
    throw new InvalidShopDomainError("Shop domain could not be parsed");
  }

  // Strip port if present
  value = value.split(":")[0]!;

  if (MYSHOPIFY_HOST.test(value)) {
    return value;
  }

  const custom = options?.customShopDomains ?? [];
  if (custom.some((d) => d.toLowerCase() === value)) {
    return value;
  }

  throw new InvalidShopDomainError(
    "Shop must be a *.myshopify.com domain (or configured custom shop domain)",
  );
}

export function shopsEqual(a: string, b: string): boolean {
  try {
    return normalizeShopDomain(a) === normalizeShopDomain(b);
  } catch {
    return false;
  }
}

/**
 * Assert that a candidate shop matches the authenticated session shop.
 * Prevents cross-shop IDOR if a client supplies another shop parameter.
 */
export function assertShopMatchesSession(
  sessionShop: string,
  candidateShop: string | null | undefined,
): string {
  const trusted = normalizeShopDomain(sessionShop);
  if (candidateShop == null || candidateShop === "") {
    return trusted;
  }
  const candidate = normalizeShopDomain(candidateShop);
  if (candidate !== trusted) {
    throw new Response("Shop mismatch", { status: 403 });
  }
  return trusted;
}
