import type { Session } from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  assertShopMatchesSession,
  normalizeShopDomain,
} from "../lib/shop-domain.server";
import { logger } from "../lib/logging.server";
import { adminGraphql, type AdminGraphqlOptions } from "./admin-graphql.server";
import { invalidateShopSessions } from "./session.server";

export type AdminAuthContext = {
  shop: string;
  session: Session;
  admin: AdminApiContext;
  /** Shop-scoped GraphQL helper with retries / throttle handling. */
  graphql: <T = unknown>(
    query: string,
    options?: Omit<AdminGraphqlOptions, "shop" | "onUnauthorized">,
  ) => Promise<{ data: T; extensions?: unknown }>;
};

/**
 * Authenticate an embedded Admin request via App Bridge session token
 * (authenticate.admin). Returns shop-isolated helpers.
 *
 * Optional `expectedShop` must match the session shop when provided
 * (e.g. form field) — never use client shop alone.
 */
export async function requireAdminAuth(
  request: Request,
  options?: { expectedShop?: string | null },
): Promise<AdminAuthContext> {
  const { admin, session } = await authenticate.admin(request);
  const shop = assertShopMatchesSession(session.shop, options?.expectedShop);

  return {
    shop,
    session,
    admin,
    graphql: (query, graphqlOptions) =>
      adminGraphql(admin, query, {
        ...graphqlOptions,
        shop,
        onUnauthorized: invalidateShopSessions,
      }),
  };
}

export type WebhookAuthContext = {
  shop: string;
  topic: string;
  session: Session | undefined;
  payload: unknown;
};

/**
 * Authenticate a Shopify webhook (HMAC). Shop comes from verified webhook headers.
 */
export async function requireWebhookAuth(
  request: Request,
): Promise<WebhookAuthContext> {
  const { shop, topic, session, payload } = await authenticate.webhook(request);
  const normalized = normalizeShopDomain(shop);
  logger.info("webhook_authenticated", { shop: normalized, topic });
  return {
    shop: normalized,
    topic,
    session,
    payload,
  };
}
