import type { Session } from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  assertShopMatchesSession,
  normalizeShopDomain,
} from "../lib/shop-domain.server";
import { logger } from "../lib/logging.server";
import { adminGraphql, type AdminGraphqlOptions } from "./admin-graphql.server";
import { ShopifySessionInvalidError } from "./errors.server";
import {
  reauthorizationResponse,
  warnIfSessionMissingScopes,
} from "./reauth.server";
import { invalidateShopSessions } from "./session.server";

export type AdminAuthContext = {
  shop: string;
  session: Session;
  admin: AdminApiContext;
  /** Scopes declared by the app but not present on this offline grant. */
  missingScopes: string[];
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
  const missingScopes = warnIfSessionMissingScopes({
    shop,
    scope: session.scope,
  });

  return {
    shop,
    session,
    admin,
    missingScopes,
    graphql: (query, graphqlOptions) =>
      adminGraphql(admin, query, {
        ...graphqlOptions,
        shop,
        onUnauthorized: invalidateShopSessions,
      }),
  };
}

/**
 * Convert API session failures into an App Bridge re-auth response.
 * Call from route actions/loaders instead of toasting raw REVOKED errors.
 */
export function throwReauthorizeIfSessionInvalid(
  error: unknown,
  shop?: string,
): void {
  if (error instanceof ShopifySessionInvalidError) {
    throw reauthorizationResponse(shop ?? error.shop);
  }
  if (
    error instanceof Response &&
    (error.status === 401 || error.status === 302)
  ) {
    throw error;
  }
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
