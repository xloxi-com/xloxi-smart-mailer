import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { assertEnvReady, getShopifyAppEnv } from "./lib/env.server";

const env =
  process.env.NODE_ENV === "production" &&
  process.env.SHOPIFY_APP_SKIP_ENV_VALIDATION !== "1"
    ? assertEnvReady()
    : getShopifyAppEnv();

/**
 * Custom distribution (Partner Dashboard) maps to AppDistribution.SingleMerchant.
 * Preserves OAuth + App Bridge session-token auth for embedded Admin.
 * Do not use AppDistribution.ShopifyAdmin — that path cannot be embedded.
 *
 * Offline access tokens are the default (useOnlineTokens unset) and are required
 * for scheduled background jobs via unauthenticated.admin(shop).
 * expiringOfflineAccessTokens enables refresh-token rotation.
 *
 * @see https://shopify.dev/docs/api/shopify-app-react-router/latest/entrypoints/shopifyapp
 * @see https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
 */
const shopify = shopifyApp({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.October26,
  scopes: env.SCOPES.split(",").map((s) => s.trim()).filter(Boolean),
  appUrl: env.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
