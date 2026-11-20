/**
 * Server-only environment validation. Never import from client routes/components.
 */

const REQUIRED_SCOPES = [
  "read_products",
  "read_inventory",
  "read_customers",
  "write_customers",
] as const;

export type ShopifyAppEnv = {
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SCOPES: string;
  DATABASE_URL: string;
  DIRECT_URL?: string;
  SHOP_CUSTOM_DOMAIN?: string;
  EMAIL_SENDING_ENABLED: boolean;
  NODE_ENV: string;
};

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // During `vite`/`react-router` typegen and some build steps env may be unset.
    // Return empty string so the module can load; runtime routes still fail closed.
    if (process.env.SHOPIFY_APP_SKIP_ENV_VALIDATION === "1") {
      return "";
    }
    // Soft during Vite config evaluation; hard at request time via assertEnvReady.
    return process.env[name] ?? "";
  }
  return value;
}

export function getShopifyAppEnv(): ShopifyAppEnv {
  const scopes =
    process.env.SCOPES?.trim() ||
    REQUIRED_SCOPES.join(",");

  return {
    SHOPIFY_API_KEY: readRequired("SHOPIFY_API_KEY"),
    SHOPIFY_API_SECRET: readRequired("SHOPIFY_API_SECRET") || "",
    SHOPIFY_APP_URL: readRequired("SHOPIFY_APP_URL") || "",
    SCOPES: scopes,
    DATABASE_URL: readRequired("DATABASE_URL") || "",
    DIRECT_URL: process.env.DIRECT_URL?.trim() || undefined,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN?.trim() || undefined,
    EMAIL_SENDING_ENABLED: process.env.EMAIL_SENDING_ENABLED === "true",
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };
}

export function assertEnvReady(): ShopifyAppEnv {
  const env = getShopifyAppEnv();
  const missing: string[] = [];
  if (!env.SHOPIFY_API_KEY) missing.push("SHOPIFY_API_KEY");
  if (!env.SHOPIFY_API_SECRET) missing.push("SHOPIFY_API_SECRET");
  if (!env.SHOPIFY_APP_URL) missing.push("SHOPIFY_APP_URL");
  if (!env.DATABASE_URL) missing.push("DATABASE_URL");

  const isProduction = env.NODE_ENV === "production";
  if (isProduction) {
    const jobsSecret =
      process.env.JOBS_SHARED_SECRET?.trim() || process.env.CRON_SECRET?.trim();
    if (!jobsSecret) missing.push("JOBS_SHARED_SECRET");
    if (
      !process.env.UNSUBSCRIBE_SIGNING_SECRET?.trim() &&
      !env.SHOPIFY_API_SECRET
    ) {
      missing.push("UNSUBSCRIBE_SIGNING_SECRET");
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  for (const scope of REQUIRED_SCOPES) {
    if (!env.SCOPES.split(",").map((s) => s.trim()).includes(scope)) {
      throw new Error(
        `SCOPES must include ${scope}. Current: ${env.SCOPES}`,
      );
    }
  }

  return env;
}

export { REQUIRED_SCOPES };
