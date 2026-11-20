import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-api";
import { unauthenticated } from "../shopify.server";
import { normalizeShopDomain } from "../lib/shop-domain.server";
import { logger } from "../lib/logging.server";
import { ShopifySessionInvalidError } from "./errors.server";
import { invalidateShopSessions } from "./session.server";
import { adminGraphql, type AdminGraphqlOptions } from "./admin-graphql.server";

export type OfflineAdminContext = {
  shop: string;
  session: Session;
  admin: AdminApiContext;
  graphql: <T = unknown>(
    query: string,
    options?: Omit<AdminGraphqlOptions, "shop" | "onUnauthorized">,
  ) => Promise<{ data: T; extensions?: unknown }>;
};

/**
 * Load a persistent offline Admin API context for background jobs.
 *
 * SECURITY: `shop` must come from a trusted source (job row written after
 * authenticate.admin / webhook, never a raw query string from the public internet).
 * This helper still validates hostname format and requires an offline Session row.
 */
export async function getOfflineAdmin(
  shopInput: string,
): Promise<OfflineAdminContext> {
  const shop = normalizeShopDomain(shopInput);

  let session: Session;
  let admin: AdminApiContext;

  try {
    ({ session, admin } = await unauthenticated.admin(shop));
  } catch (error) {
    logger.warn("offline_admin_missing_session", {
      shop,
      name: error instanceof Error ? error.name : "unknown",
    });
    throw new ShopifySessionInvalidError(shop, "MISSING");
  }

  if (session.isOnline) {
    // Prefer offline; try to find offline among shop sessions via storage path.
    throw new ShopifySessionInvalidError(
      shop,
      "MISSING",
      "Expected offline session for background jobs",
    );
  }

  if (session.expires && session.expires.getTime() < Date.now()) {
    // Library usually refreshes when expiringOfflineAccessTokens is enabled;
    // if we still see an expired session, force re-auth.
    await invalidateShopSessions(shop);
    throw new ShopifySessionInvalidError(shop, "EXPIRED");
  }

  return {
    shop: session.shop,
    session,
    admin,
    graphql: (query, options) =>
      adminGraphql(admin, query, {
        ...options,
        shop: session.shop,
        onUnauthorized: invalidateShopSessions,
      }),
  };
}
