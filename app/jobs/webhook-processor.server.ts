/**
 * Durable webhook processor — claims PENDING/FAILED events and syncs mirrors.
 * Heavy Shopify GraphQL work happens here, not in the HTTP ingress path.
 */
import type { Prisma, WebhookEvent } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { getOfflineAdmin } from "../shopify/offline-admin.server";
import {
  softDeleteSubscriberByGid,
  syncSingleCustomer,
  redactSubscriberPrivacy,
} from "../services/customer-sync.server";
import {
  softDeleteProductByGid,
  syncSingleProduct,
} from "../services/product-sync.server";
import { applyInventoryLevelUpdate } from "../services/inventory-sync.server";
import { ensureShop, getShopByDomain } from "../services/shop.server";
import { handleAppUninstalled } from "../services/webhook-uninstall.server";
import {
  listDueWebhookEvents,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSkipped,
  markWebhookSucceeded,
} from "../services/webhook-events.server";

function topicKey(topic: string): string {
  return topic.toLowerCase();
}

function safePayload(event: WebhookEvent): Record<string, unknown> {
  if (!event.safePayload || typeof event.safePayload !== "object") return {};
  return event.safePayload as Record<string, unknown>;
}

/**
 * Skip stale product/customer updates when a newer mirror already exists.
 */
async function isStaleResourceUpdate(event: WebhookEvent): Promise<boolean> {
  if (!event.resourceUpdatedAt || !event.resourceGid || !event.shopId) {
    return false;
  }
  const key = topicKey(event.topic);
  if (key.startsWith("products/") && !key.endsWith("/delete")) {
    const product = await prisma.product.findFirst({
      where: {
        shopId: event.shopId,
        shopifyProductGid: event.resourceGid,
      },
      select: { lastSyncedAt: true, shopifyUpdatedAt: true },
    });
    const mirrorAt = product?.shopifyUpdatedAt ?? product?.lastSyncedAt;
    if (mirrorAt && mirrorAt > event.resourceUpdatedAt) return true;
  }
  // Never stale-skip customers/update — Flow tags/metafields must always run.
  // Local subscriber.updatedAt is bumped by our own tag/metafield writes and
  // would otherwise drop acknowledgement webhooks as "stale_out_of_order".
  if (key === "customers_email_marketing_consent/update") {
    const sub = await prisma.subscriber.findFirst({
      where: {
        shopId: event.shopId,
        shopifyCustomerGid: event.resourceGid,
      },
      select: { consentUpdatedAt: true },
    });
    const mirrorAt = sub?.consentUpdatedAt;
    if (mirrorAt && mirrorAt > event.resourceUpdatedAt) return true;
  }
  return false;
}

async function processEventBody(event: WebhookEvent): Promise<void> {
  const topic = topicKey(event.topic);
  const safe = safePayload(event);
  const shopDomain = event.shopDomain;

  if (topic === "app/uninstalled") {
    await handleAppUninstalled({
      shopDomain,
      shopId: event.shopId,
    });
    return;
  }

  const shop =
    event.shopId != null
      ? await prisma.shop.findUnique({
          where: { id: event.shopId },
          include: { automationSettings: true },
        })
      : await getShopByDomain(shopDomain);

  if (!shop) {
    await ensureShop(shopDomain);
  }
  const shopRow = (shop ?? (await ensureShop(shopDomain)))!;

  if (shopRow.uninstalledAt && topic !== "shop/redact") {
    // Still allow compliance redaction after uninstall; skip sync topics.
    if (
      topic !== "customers/data_request" &&
      topic !== "customers/redact" &&
      topic !== "shop/redact"
    ) {
      throw new Error("shop_uninstalled_skip_sync");
    }
  }

  if (await isStaleResourceUpdate(event)) {
    await markWebhookSkipped(event.id, "stale_out_of_order");
    return;
  }

  if (topic === "products/create" || topic === "products/update") {
    const productGid =
      event.resourceGid ??
      (typeof safe.productGid === "string" ? safe.productGid : null);
    if (!productGid) {
      await markWebhookSkipped(event.id, "missing_product_gid");
      return;
    }
    const { admin } = await getOfflineAdmin(shopDomain);
    await syncSingleProduct(
      admin,
      shopDomain,
      shopRow.id,
      productGid,
      shopRow.automationSettings?.inStockOnly !== false,
    );
    return;
  }

  if (topic === "products/delete") {
    const productGid =
      event.resourceGid ??
      (typeof safe.productGid === "string" ? safe.productGid : null);
    if (!productGid) {
      await markWebhookSkipped(event.id, "missing_product_gid");
      return;
    }
    await softDeleteProductByGid(shopRow.id, productGid);
    return;
  }

  if (topic === "inventory_levels/update") {
    const inventoryItemGid =
      event.resourceGid ??
      (typeof safe.inventoryItemGid === "string"
        ? safe.inventoryItemGid
        : null);
    if (!inventoryItemGid) {
      await markWebhookSkipped(event.id, "missing_inventory_item");
      return;
    }
    const available =
      typeof safe.available === "number" ? safe.available : undefined;
    try {
      const { admin } = await getOfflineAdmin(shopDomain);
      await applyInventoryLevelUpdate({
        shopId: shopRow.id,
        shopDomain,
        inventoryItemGidOrLegacyId: inventoryItemGid,
        available,
        inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
        client: admin,
      });
    } catch {
      // Offline session may be gone; apply quantity hint locally.
      await applyInventoryLevelUpdate({
        shopId: shopRow.id,
        shopDomain,
        inventoryItemGidOrLegacyId: inventoryItemGid,
        available,
        inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
      });
    }
    return;
  }

  if (
    topic === "customers/create" ||
    topic === "customers/update" ||
    topic === "customers_email_marketing_consent/update"
  ) {
    const customerGid =
      event.resourceGid ??
      (typeof safe.customerGid === "string" ? safe.customerGid : null);
    if (!customerGid) {
      await markWebhookSkipped(event.id, "missing_customer_gid");
      return;
    }
    const { admin } = await getOfflineAdmin(shopDomain);
    await syncSingleCustomer(
      admin,
      shopDomain,
      shopRow.id,
      customerGid,
      shopRow.automationSettings?.intervalDays ?? 3,
    );

    // Flow bridge: detect xloxi-request / processed_batch_id acknowledgement.
    // Only on customers/update (tag/metafield writes). Consent-only updates skip.
    if (topic === "customers/update") {
      const settings = shopRow.automationSettings;
      const { processCustomerFlowUpdate } = await import(
        "../services/flow-selection.server"
      );
      const flowResult = await processCustomerFlowUpdate({
        client: admin,
        shopDomain,
        shopId: shopRow.id,
        customerGid,
        intervalDays: settings?.intervalDays ?? 3,
        productsPerEmail: settings?.productsPerEmail ?? 4,
        inStockOnly: settings?.inStockOnly !== false,
        automationEnabled: settings?.automationEnabled === true,
        testMode: settings?.testMode !== false,
      });
      logger.info("flow_customer_update_processed", {
        shop: shopDomain,
        customerGid,
        status: flowResult.status,
        reason:
          flowResult.status === "skipped" || flowResult.status === "failed"
            ? flowResult.reason
            : undefined,
        batchId:
          flowResult.status === "ready" ||
          flowResult.status === "acknowledged"
            ? flowResult.batchId
            : undefined,
        productCount:
          flowResult.status === "ready" ? flowResult.productCount : undefined,
      });
    }
    return;
  }

  if (topic === "customers/delete") {
    const customerGid =
      event.resourceGid ??
      (typeof safe.customerGid === "string" ? safe.customerGid : null);
    if (!customerGid) {
      await markWebhookSkipped(event.id, "missing_customer_gid");
      return;
    }
    await softDeleteSubscriberByGid(shopRow.id, customerGid);
    return;
  }

  if (topic === "customers/data_request") {
    await prisma.auditLog.create({
      data: {
        shopId: shopRow.id,
        action: "WEBHOOK",
        entityType: "CustomerDataRequest",
        entityId: event.resourceGid,
        actorType: "shopify",
        metadata: { topic: event.topic } as Prisma.InputJsonValue,
      },
    });
    logger.info("customers_data_request_recorded", {
      shop: shopDomain,
      topic: event.topic,
    });
    return;
  }

  if (topic === "customers/redact") {
    await redactSubscriberPrivacy({
      shopId: shopRow.id,
      shopifyCustomerGid: event.resourceGid,
      email: null,
    });
    return;
  }

  if (topic === "shop/redact") {
    await handleAppUninstalled({
      shopDomain,
      shopId: shopRow.id,
    });

    const subs = await prisma.subscriber.findMany({
      where: { shopId: shopRow.id },
      select: { id: true },
    });
    for (const sub of subs) {
      await prisma.subscriber.update({
        where: { id: sub.id },
        data: {
          email: "",
          emailNormalized: `shop-redact:${sub.id}`,
          eligible: false,
          isSuppressed: true,
          deletedAt: new Date(),
        },
      });
    }

    await prisma.suppression.updateMany({
      where: { shopId: shopRow.id },
      data: {
        emailNormalized: `shop-redact:${shopRow.id}`,
        active: false,
        notes: "shop_redact",
        liftedAt: new Date(),
      },
    });

    await prisma.shop.update({
      where: { id: shopRow.id },
      data: { uninstalledAt: new Date(), email: null, name: null },
    });
    return;
  }

  if (topic === "app/scopes_update") {
    const scopes = Array.isArray(safe.currentScopes)
      ? (safe.currentScopes as string[])
      : null;
    if (scopes) {
      await prisma.session.updateMany({
        where: { shop: shopDomain, isOnline: false },
        data: { scope: scopes.join(",") },
      });
    }
    await prisma.auditLog.create({
      data: {
        shopId: shopRow.id,
        action: "WEBHOOK",
        entityType: "AppScopes",
        entityId: shopRow.id,
        actorType: "shopify",
        metadata: {
          topic: event.topic,
          currentScopes: scopes,
        } as Prisma.InputJsonValue,
      },
    });
    return;
  }

  await markWebhookSkipped(event.id, `unhandled_topic:${event.topic}`);
}

export async function processWebhookEventById(
  eventId: string,
  leaseOwner = "webhook-worker",
): Promise<{ status: string }> {
  const claimed = await markWebhookProcessing(eventId, leaseOwner);
  if (!claimed) {
    return { status: "not_claimable" };
  }

  try {
    await processEventBody(claimed);
    // processEventBody may have already marked SKIPPED
    const current = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
    });
    if (current?.status === "PROCESSING") {
      await markWebhookSucceeded(eventId);
    }
    return { status: current?.status === "SKIPPED" ? "skipped" : "succeeded" };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "shop_uninstalled_skip_sync"
    ) {
      await markWebhookSkipped(eventId, "shop_uninstalled");
      return { status: "skipped" };
    }
    await markWebhookFailed(eventId, error);
    return { status: "failed" };
  }
}

export async function processDueWebhookEvents(options?: {
  limit?: number;
  leaseOwner?: string;
}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const due = await listDueWebhookEvents(options?.limit ?? 25);
  let succeeded = 0;
  let failed = 0;
  for (const event of due) {
    const result = await processWebhookEventById(
      event.id,
      options?.leaseOwner ?? "webhook-worker",
    );
    if (result.status === "succeeded" || result.status === "skipped") {
      succeeded += 1;
    } else if (result.status === "failed") {
      failed += 1;
    }
  }
  return { processed: due.length, succeeded, failed };
}

/** Fire-and-forget after HTTP ack (best-effort immediate processing). */
export function scheduleWebhookProcessing(eventId: string): void {
  void processWebhookEventById(eventId, "ingress-inline").catch((error) => {
    logger.error("webhook_inline_schedule_failed", {
      eventId,
      name: error instanceof Error ? error.name : "unknown",
    });
  });
}
