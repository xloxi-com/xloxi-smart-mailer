/**
 * Fast webhook ingress: authenticate → dedupe → enqueue durable job → ack.
 * Heavy sync runs asynchronously via webhook-processor.
 */
import { requireWebhookAuth } from "../shopify/auth.server";
import { logger } from "../lib/logging.server";
import { ensureShop } from "./shop.server";
import {
  enqueueWebhookEvent,
  readShopifyApiVersion,
  readShopifyTriggeredAt,
  readShopifyWebhookId,
} from "./webhook-events.server";
import { scheduleWebhookProcessing } from "../jobs/webhook-processor.server";

export type AcceptWebhookResult =
  | { ok: true; duplicate: boolean; eventId: string | null }
  | { ok: false; reason: string };

/**
 * Authenticate (HMAC via authenticate.webhook), persist a durable event, schedule work.
 * Returns quickly so Shopify gets a fast 200.
 */
export async function acceptShopifyWebhook(
  request: Request,
): Promise<AcceptWebhookResult> {
  const { shop, topic, payload } = await requireWebhookAuth(request);
  const webhookId = readShopifyWebhookId(request);
  const apiVersion = readShopifyApiVersion(request);
  const triggeredAt = readShopifyTriggeredAt(request);

  const shopRow = await ensureShop(shop);

  const enqueued = await enqueueWebhookEvent({
    shopDomain: shop,
    shopId: shopRow.id,
    topic,
    webhookId,
    apiVersion,
    payload,
    triggeredAt,
  });

  if (enqueued.duplicate) {
    // Shopify retries while the first delivery is still PENDING/stuck — re-drive.
    const existing = enqueued.event;
    if (
      existing &&
      (existing.status === "PENDING" ||
        existing.status === "FAILED" ||
        existing.status === "PROCESSING")
    ) {
      scheduleWebhookProcessing(existing.id);
    }
    return {
      ok: true,
      duplicate: true,
      eventId: existing?.id ?? null,
    };
  }

  scheduleWebhookProcessing(enqueued.event.id);

  logger.info("webhook_accepted", {
    shop,
    topic,
    webhookId: enqueued.event.webhookId,
    eventId: enqueued.event.id,
    resourceGid: enqueued.event.resourceGid,
  });

  return { ok: true, duplicate: false, eventId: enqueued.event.id };
}

/**
 * Route action helper — authenticates, enqueues, always acks 200 on success path.
 * Invalid HMAC / auth failures propagate as thrown Response from Shopify SDK.
 */
export async function webhookAction(
  request: Request,
): Promise<Response> {
  await acceptShopifyWebhook(request);
  return new Response(null, { status: 200 });
}
