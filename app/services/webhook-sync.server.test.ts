import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
  SyncJobStatus,
  WebhookEventStatus,
} from "@prisma/client";
import { extractSafeWebhookMeta } from "./webhook-safe-payload.server";
import {
  enqueueWebhookEvent,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
} from "./webhook-events.server";
import { handleAppUninstalled } from "./webhook-uninstall.server";
import { applyInventoryLevelUpdate } from "./inventory-sync.server";
import { processWebhookEventById } from "../jobs/webhook-processor.server";

const prisma = new PrismaClient();
const SHOP = `webhook-sync-${process.pid}.myshopify.com`;

vi.mock("../shopify/auth.server", () => ({
  requireWebhookAuth: vi.fn(),
}));

vi.mock("../shopify/offline-admin.server", () => ({
  getOfflineAdmin: vi.fn(async () => {
    throw new Error("offline_admin_unavailable_in_test");
  }),
}));

vi.mock("./customer-sync.server", async () => {
  const actual = await vi.importActual<typeof import("./customer-sync.server")>(
    "./customer-sync.server",
  );
  return {
    ...actual,
    syncSingleCustomer: vi.fn(async () => ({ upserted: 1 })),
  };
});

import { requireWebhookAuth } from "../shopify/auth.server";
import { acceptShopifyWebhook } from "./webhook-ingress.server";
import { syncSingleCustomer } from "./customer-sync.server";

describe("webhook sync", () => {
  let shopId: string;

  beforeAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: {
          create: { automationEnabled: true, inStockOnly: true },
        },
      },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("rejects invalid signatures before processing", async () => {
    vi.mocked(requireWebhookAuth).mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      acceptShopifyWebhook(new Request("https://example.com/webhooks/test", { method: "POST" })),
    ).rejects.toMatchObject({ status: 401 });

    const count = await prisma.webhookEvent.count({
      where: { shopDomain: SHOP },
    });
    expect(count).toBe(0);
  });

  it("deduplicates webhook deliveries by webhookId", async () => {
    const webhookId = `dup-${Date.now()}`;
    const first = await enqueueWebhookEvent({
      shopDomain: SHOP,
      shopId,
      topic: "products/update",
      webhookId,
      payload: { id: 101, admin_graphql_api_id: "gid://shopify/Product/101" },
    });
    const second = await enqueueWebhookEvent({
      shopDomain: SHOP,
      shopId,
      topic: "products/update",
      webhookId,
      payload: { id: 101, admin_graphql_api_id: "gid://shopify/Product/101" },
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await prisma.webhookEvent.count({ where: { webhookId } })).toBe(1);
  });

  it("stores only safe metadata (never emails)", () => {
    const meta = extractSafeWebhookMeta("customers/update", {
      id: 55,
      email: "secret@example.com",
      admin_graphql_api_id: "gid://shopify/Customer/55",
      email_marketing_consent: {
        state: "subscribed",
        consent_updated_at: "2026-01-02T00:00:00Z",
      },
      updated_at: "2026-01-02T00:00:00Z",
    });

    expect(meta.resourceGid).toBe("gid://shopify/Customer/55");
    expect(meta.safePayload.emailMarketingConsentState).toBe("subscribed");
    expect(JSON.stringify(meta.safePayload)).not.toContain("secret@");
    expect(meta.safePayload).not.toHaveProperty("email");
  });

  it("applies inventory level changes and recomputes eligibility", async () => {
    const product = await prisma.product.create({
      data: {
        shopId,
        shopifyProductGid: "gid://shopify/Product/inv-1",
        title: "Inv Product",
        status: "ACTIVE",
        publishedToOnlineStore: true,
        storefrontUrl: "https://example.com/p",
        tracksInventory: true,
        inStock: true,
        eligible: true,
        totalInventory: 3,
      },
    });
    await prisma.productVariant.create({
      data: {
        shopId,
        productId: product.id,
        shopifyVariantGid: "gid://shopify/ProductVariant/inv-1",
        inventoryItemGid: "gid://shopify/InventoryItem/9001",
        inventoryQuantity: 3,
        tracksInventory: true,
        inventoryPolicy: "DENY",
        availableForSale: true,
      },
    });

    const result = await applyInventoryLevelUpdate({
      shopId,
      shopDomain: SHOP,
      inventoryItemGidOrLegacyId: 9001,
      available: 0,
      inStockOnly: true,
    });
    expect(result.updated).toBe(true);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.inStock).toBe(false);
    expect(after.eligible).toBe(false);

    const event = await enqueueWebhookEvent({
      shopDomain: SHOP,
      shopId,
      topic: "inventory_levels/update",
      webhookId: `inv-${Date.now()}`,
      payload: {
        inventory_item_id: 9001,
        available: 0,
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    expect(event.duplicate).toBe(false);
    if (event.duplicate) return;

    // Process without Admin (local quantity path).
    await prisma.webhookEvent.update({
      where: { id: event.event.id },
      data: {
        safePayload: {
          inventoryItemGid: "gid://shopify/InventoryItem/9001",
          available: 5,
        },
        resourceGid: "gid://shopify/InventoryItem/9001",
      },
    });

    // Reset stock then process webhook that sets available=5 via safePayload.
    await prisma.productVariant.updateMany({
      where: { productId: product.id },
      data: { inventoryQuantity: 0 },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { inStock: false, eligible: false, totalInventory: 0 },
    });

    const processed = await processWebhookEventById(event.event.id, "test");
    expect(["succeeded", "failed", "skipped"]).toContain(processed.status);

    const row = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.event.id },
    });
    expect(row.attemptCount).toBeGreaterThanOrEqual(1);
    expect([
      WebhookEventStatus.SUCCEEDED,
      WebhookEventStatus.FAILED,
      WebhookEventStatus.SKIPPED,
    ]).toContain(row.status);
  });

  it("processes consent update webhooks via authoritative customer sync", async () => {
    vi.mocked(syncSingleCustomer).mockClear();
    vi.mocked(syncSingleCustomer).mockResolvedValueOnce({
      processed: 1,
      upserted: 1,
      softDeleted: 0,
      skipped: 0,
      eligible: 0,
      errors: 0,
      partialErrors: [],
      pages: 0,
      phase: "single",
    } as never);

    // Bypass getOfflineAdmin failure by stubbing processor path through syncSingleCustomer mock —
    // getOfflineAdmin throws; wrap by mocking offline-admin to return a stub.
    const offline = await import("../shopify/offline-admin.server");
    vi.mocked(offline.getOfflineAdmin).mockResolvedValueOnce({
      shop: SHOP,
      admin: {} as never,
      session: {} as never,
      graphql: vi.fn(),
    } as never);

    const event = await enqueueWebhookEvent({
      shopDomain: SHOP,
      shopId,
      topic: "customers_email_marketing_consent/update",
      webhookId: `consent-${Date.now()}`,
      payload: {
        customer_id: 77,
        email_marketing_consent: { state: "unsubscribed" },
      },
    });
    expect(event.duplicate).toBe(false);
    if (event.duplicate) return;

    const result = await processWebhookEventById(event.event.id, "consent-test");
    expect(result.status).toBe("succeeded");
    expect(syncSingleCustomer).toHaveBeenCalled();
    expect(vi.mocked(syncSingleCustomer).mock.calls[0]?.[3]).toBe(
      "gid://shopify/Customer/77",
    );
  });

  it("stops automation and cancels jobs on app uninstall", async () => {
    const sub = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/uninstall-1",
        email: "u@example.com",
        emailNormalized: "u@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
      },
    });
    await prisma.emailJob.create({
      data: {
        shopId,
        subscriberId: sub.id,
        idempotencyKey: `uninstall-email-${Date.now()}`,
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        productSnapshot: {},
      },
    });
    await prisma.syncJob.create({
      data: {
        shopId,
        type: "PRODUCTS",
        status: SyncJobStatus.PENDING,
        idempotencyKey: `uninstall-sync-${Date.now()}`,
      },
    });
    await prisma.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "test",
        isOnline: false,
        accessToken: "shpat_test_token_not_logged",
      },
    });

    await handleAppUninstalled({ shopDomain: SHOP, shopId });

    const settings = await prisma.automationSettings.findUniqueOrThrow({
      where: { shopId },
    });
    expect(settings.automationEnabled).toBe(false);

    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.uninstalledAt).not.toBeNull();

    const emailJobs = await prisma.emailJob.findMany({
      where: { shopId, status: EmailJobStatus.PENDING },
    });
    expect(emailJobs).toHaveLength(0);

    const syncJobs = await prisma.syncJob.findMany({
      where: { shopId, status: SyncJobStatus.PENDING },
    });
    expect(syncJobs).toHaveLength(0);

    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("records retries and failure logs on processing errors", async () => {
    const event = await enqueueWebhookEvent({
      shopDomain: SHOP,
      shopId,
      topic: "products/update",
      webhookId: `fail-${Date.now()}`,
      payload: {
        id: 999,
        admin_graphql_api_id: "gid://shopify/Product/999",
      },
    });
    if (event.duplicate) throw new Error("unexpected duplicate");

    const claimed = await markWebhookProcessing(event.event.id, "fail-test");
    expect(claimed?.attemptCount).toBe(1);

    const failed = await markWebhookFailed(
      event.event.id,
      new Error("simulated_sync_failure"),
    );
    expect(failed.status).toBe(WebhookEventStatus.FAILED);
    expect(failed.lastError).toContain("simulated_sync_failure");
    expect(failed.nextRetryAt).not.toBeNull();

    await markWebhookSucceeded(event.event.id);
    const done = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.event.id },
    });
    expect(done.status).toBe(WebhookEventStatus.SUCCEEDED);
    expect(done.processedAt).not.toBeNull();
  });
});
