/**
 * Extract minimal safe webhook metadata — never emails, tokens, or credentials.
 */
import { createHash } from "node:crypto";

export type SafeWebhookPayload = {
  resourceGid: string | null;
  resourceUpdatedAt: Date | null;
  /** JSON-serializable ids/quantities only. */
  safePayload: Record<string, unknown>;
  payloadHash: string;
};

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function parseUpdatedAt(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function productGid(body: Record<string, unknown>): string | null {
  if (typeof body.admin_graphql_api_id === "string") return body.admin_graphql_api_id;
  if (typeof body.id === "number" || typeof body.id === "string") {
    return `gid://shopify/Product/${body.id}`;
  }
  return null;
}

function customerGid(body: Record<string, unknown>): string | null {
  if (typeof body.admin_graphql_api_id === "string") return body.admin_graphql_api_id;
  if (typeof body.id === "number" || typeof body.id === "string") {
    return `gid://shopify/Customer/${body.id}`;
  }
  // Consent webhook nests under customer_id
  if (typeof body.customer_id === "number" || typeof body.customer_id === "string") {
    return `gid://shopify/Customer/${body.customer_id}`;
  }
  const customer = body.customer;
  if (customer && typeof customer === "object") {
    const c = customer as Record<string, unknown>;
    if (typeof c.id === "number" || typeof c.id === "string") {
      return `gid://shopify/Customer/${c.id}`;
    }
  }
  return null;
}

function inventoryItemGid(body: Record<string, unknown>): string | null {
  if (body.inventory_item_id == null) return null;
  return `gid://shopify/InventoryItem/${body.inventory_item_id}`;
}

function hashTopicPayload(topic: string, safe: Record<string, unknown>): string {
  return createHash("sha256")
    .update(topic)
    .update(JSON.stringify(safe))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Build a PII-free summary of a webhook payload for durable storage/logs.
 */
export function extractSafeWebhookMeta(
  topic: string,
  payload: unknown,
): SafeWebhookPayload {
  const normalized = topic.toLowerCase().replace(/_/g, "/");
  const body = asRecord(payload) ?? {};
  const safePayload: Record<string, unknown> = {};
  let resourceGid: string | null = null;
  let resourceUpdatedAt = parseUpdatedAt(body.updated_at);

  if (
    normalized.includes("products/")
  ) {
    resourceGid = productGid(body);
    if (resourceGid) safePayload.productGid = resourceGid;
    if (typeof body.status === "string") safePayload.status = body.status;
  } else if (
    normalized.includes("customers/") ||
    normalized.includes("customers/email/marketing/consent") ||
    topic.toLowerCase() === "customers_email_marketing_consent/update"
  ) {
    resourceGid = customerGid(body);
    if (resourceGid) safePayload.customerGid = resourceGid;
    // Consent state only — never the email address.
    const consent =
      body.email_marketing_consent &&
      typeof body.email_marketing_consent === "object"
        ? (body.email_marketing_consent as Record<string, unknown>)
        : null;
    if (consent && typeof consent.state === "string") {
      safePayload.emailMarketingConsentState = consent.state;
      resourceUpdatedAt =
        parseUpdatedAt(consent.consent_updated_at) ?? resourceUpdatedAt;
    }
  } else if (normalized.includes("inventory")) {
    resourceGid = inventoryItemGid(body);
    if (resourceGid) safePayload.inventoryItemGid = resourceGid;
    if (body.available != null) safePayload.available = body.available;
    if (body.location_id != null) safePayload.locationId = body.location_id;
  } else if (
    normalized.includes("customers/data/request") ||
    topic.toLowerCase() === "customers/data_request"
  ) {
    resourceGid = customerGid(body);
    if (resourceGid) safePayload.customerGid = resourceGid;
    safePayload.kind = "data_request";
  } else if (
    normalized.includes("customers/redact") ||
    topic.toLowerCase() === "customers/redact"
  ) {
    resourceGid = customerGid(body);
    if (resourceGid) safePayload.customerGid = resourceGid;
    safePayload.kind = "customers_redact";
  } else if (
    normalized.includes("shop/redact") ||
    topic.toLowerCase() === "shop/redact"
  ) {
    safePayload.kind = "shop_redact";
  } else if (normalized.includes("app/uninstalled")) {
    safePayload.kind = "app_uninstalled";
  } else if (normalized.includes("app/scopes")) {
    if (Array.isArray(body.current)) safePayload.currentScopes = body.current;
  }

  return {
    resourceGid,
    resourceUpdatedAt,
    safePayload,
    payloadHash: hashTopicPayload(topic, safePayload),
  };
}
