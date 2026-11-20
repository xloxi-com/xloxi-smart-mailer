import { afterEach, describe, expect, it } from "vitest";
import { assertEnvReady } from "./env.server";

describe("assertEnvReady", () => {
  const prev = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  });

  it("requires job secret in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_API_KEY = "key";
    process.env.SHOPIFY_API_SECRET = "secret";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.DATABASE_URL = "postgresql://localhost/db";
    process.env.SCOPES =
      "read_products,read_inventory,read_customers,write_customers";
    delete process.env.JOBS_SHARED_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.SHOPIFY_APP_SKIP_ENV_VALIDATION;

    expect(() => assertEnvReady()).toThrow(/JOBS_SHARED_SECRET/);
  });

  it("passes when production secrets are present", () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_API_KEY = "key";
    process.env.SHOPIFY_API_SECRET = "secret";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.DATABASE_URL = "postgresql://localhost/db";
    process.env.JOBS_SHARED_SECRET = "jobs";
    process.env.UNSUBSCRIBE_SIGNING_SECRET = "unsub";
    process.env.SCOPES =
      "read_products,read_inventory,read_customers,write_customers";
    delete process.env.SHOPIFY_APP_SKIP_ENV_VALIDATION;

    expect(assertEnvReady().SHOPIFY_API_KEY).toBe("key");
  });
});
