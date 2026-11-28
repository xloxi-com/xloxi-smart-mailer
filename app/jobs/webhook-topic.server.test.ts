import { describe, expect, it } from "vitest";

// Mirror the production mapper (keep in sync with webhook-processor.server.ts).
const WEBHOOK_TOPIC_MAP: Record<string, string> = {
  app_uninstalled: "app/uninstalled",
  app_scopes_update: "app/scopes_update",
  products_create: "products/create",
  products_update: "products/update",
  products_delete: "products/delete",
  inventory_levels_update: "inventory_levels/update",
  customers_create: "customers/create",
  customers_update: "customers/update",
  customers_delete: "customers/delete",
  customers_email_marketing_consent_update:
    "customers/email_marketing_consent/update",
  customers_data_request: "customers/data_request",
  customers_redact: "customers/redact",
  shop_redact: "shop/redact",
};

function topicKey(topic: string): string {
  const lower = topic.toLowerCase().trim();
  if (lower.includes("/")) return lower;
  return WEBHOOK_TOPIC_MAP[lower] ?? lower;
}

describe("webhook topicKey", () => {
  it("maps Shopify enum topics to slash form", () => {
    expect(topicKey("CUSTOMERS_UPDATE")).toBe("customers/update");
    expect(topicKey("CUSTOMERS_CREATE")).toBe("customers/create");
    expect(topicKey("CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE")).toBe(
      "customers/email_marketing_consent/update",
    );
    expect(topicKey("PRODUCTS_UPDATE")).toBe("products/update");
    expect(topicKey("INVENTORY_LEVELS_UPDATE")).toBe(
      "inventory_levels/update",
    );
  });

  it("passes through already-normalized topics", () => {
    expect(topicKey("customers/update")).toBe("customers/update");
  });
});
