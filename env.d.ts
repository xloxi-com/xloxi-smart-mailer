/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_URL?: string;
    DIRECT_URL?: string;
    SHOPIFY_API_KEY?: string;
    SHOPIFY_API_SECRET?: string;
    SHOPIFY_APP_URL?: string;
    SCOPES?: string;
    SHOP_CUSTOM_DOMAIN?: string;
    EMAIL_SENDING_ENABLED?: string;
    CRON_SECRET?: string;
    SHOPIFY_APP_SKIP_ENV_VALIDATION?: string;
    NODE_ENV?: string;
  }
}
