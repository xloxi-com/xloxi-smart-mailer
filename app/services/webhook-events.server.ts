/**
 * Durable webhook event ledger: dedupe, status, retries, safe metadata.
 */
import type { Prisma, WebhookEvent } from "@prisma/client";
import prisma from "../db.server";
import { WebhookEventStatus } from "../lib/prisma.server";
import { logger } from "../lib/logging.server";
import { extractSafeWebhookMeta } from "./webhook-safe-payload.server";

export function readShopifyWebhookId(request: Request): string {
  return (
    request.headers.get("x-shopify-webhook-id") ||
    request.headers.get("X-Shopify-Webhook-Id") ||
    ""
  );
}

export function readShopifyApiVersion(request: Request): string | null {
  return (
    request.headers.get("x-shopify-api-version") ||
    request.headers.get("X-Shopify-API-Version")
  );
}

export function readShopifyTriggeredAt(request: Request): Date | null {
  const raw =
    request.headers.get("x-shopify-triggered-at") ||
    request.headers.get("X-Shopify-Triggered-At");
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type EnqueueWebhookResult =
  | { duplicate: false; event: WebhookEvent }
  | { duplicate: true; event: WebhookEvent | null };

/**
 * Insert a PENDING webhook event. Unique webhookId is the final dedupe safeguard.
 */
export async function enqueueWebhookEvent(options: {
  shopDomain: string;
  shopId?: string | null;
  topic: string;
  webhookId: string;
  apiVersion?: string | null;
  payload: unknown;
  triggeredAt?: Date | null;
}): Promise<EnqueueWebhookResult> {
  if (!options.webhookId) {
    // Missing delivery id — still process once under a synthetic key, but log.
    logger.warn("webhook_missing_delivery_id", {
      shop: options.shopDomain,
      topic: options.topic,
    });
  }

  const webhookId =
    options.webhookId ||
    `missing:${options.shopDomain}:${options.topic}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const meta = extractSafeWebhookMeta(options.topic, options.payload);
  const resourceUpdatedAt =
    meta.resourceUpdatedAt ?? options.triggeredAt ?? null;

  try {
    const event = await prisma.webhookEvent.create({
      data: {
        shopDomain: options.shopDomain,
        shopId: options.shopId ?? null,
        topic: options.topic,
        webhookId,
        apiVersion: options.apiVersion ?? null,
        status: WebhookEventStatus.PENDING,
        resourceGid: meta.resourceGid,
        resourceUpdatedAt,
        payloadHash: meta.payloadHash,
        safePayload: meta.safePayload as Prisma.InputJsonValue,
        nextRetryAt: new Date(),
      },
    });
    return { duplicate: false, event };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "";
    if (code !== "P2002") throw error;

    const existing = await prisma.webhookEvent.findFirst({
      where: {
        OR: [
          { webhookId },
          {
            shopDomain: options.shopDomain,
            topic: options.topic,
            webhookId,
          },
        ],
      },
    });
    logger.info("webhook_duplicate_delivery", {
      shop: options.shopDomain,
      topic: options.topic,
      webhookId,
      existingStatus: existing?.status,
    });
    return { duplicate: true, event: existing };
  }
}

/** @deprecated Prefer enqueueWebhookEvent — kept for older call sites/tests. */
export async function claimWebhookEvent(options: {
  shopDomain: string;
  shopId?: string | null;
  topic: string;
  webhookId: string;
  apiVersion?: string | null;
}): Promise<boolean> {
  const result = await enqueueWebhookEvent({
    ...options,
    payload: {},
  });
  return !result.duplicate;
}

export async function markWebhookProcessing(
  eventId: string,
  leaseOwner: string,
  leaseMs = 60_000,
): Promise<WebhookEvent | null> {
  const now = new Date();
  const updated = await prisma.webhookEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: WebhookEventStatus.PENDING },
        {
          status: WebhookEventStatus.FAILED,
          nextRetryAt: { lte: now },
        },
        {
          status: WebhookEventStatus.PROCESSING,
          leaseExpiresAt: { lte: now },
        },
      ],
    },
    data: {
      status: WebhookEventStatus.PROCESSING,
      attemptCount: { increment: 1 },
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastError: null,
    },
  });
  if (updated.count === 0) return null;
  return prisma.webhookEvent.findUnique({ where: { id: eventId } });
}

export async function markWebhookSucceeded(eventId: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: WebhookEventStatus.SUCCEEDED,
      processedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      lastError: null,
    },
  });
}

export async function markWebhookSkipped(
  eventId: string,
  reason: string,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: WebhookEventStatus.SKIPPED,
      processedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      lastError: reason.slice(0, 500),
    },
  });
}

export async function markWebhookFailed(
  eventId: string,
  error: unknown,
): Promise<WebhookEvent> {
  const event = await prisma.webhookEvent.findUniqueOrThrow({
    where: { id: eventId },
  });
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const attempts = event.attemptCount;
  const exhausted = attempts >= event.maxAttempts;
  const backoffMs = Math.min(60_000, 2 ** Math.min(attempts, 6) * 1_000);
  const nextRetryAt = exhausted ? null : new Date(Date.now() + backoffMs);

  logger.error("webhook_processing_failed", {
    shop: event.shopDomain,
    topic: event.topic,
    webhookId: event.webhookId,
    attemptCount: attempts,
    exhausted,
    name: error instanceof Error ? error.name : "unknown",
  });

  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: WebhookEventStatus.FAILED,
      lastError: message.slice(0, 1000),
      processingError: message.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRetryAt: exhausted ? null : nextRetryAt,
      ...(exhausted ? { processedAt: new Date() } : {}),
    },
  });
}

/**
 * Claim due webhook jobs for a worker tick.
 */
export async function listDueWebhookEvents(
  limit = 25,
): Promise<WebhookEvent[]> {
  const now = new Date();
  return prisma.webhookEvent.findMany({
    where: {
      OR: [
        {
          status: WebhookEventStatus.PENDING,
          nextRetryAt: { lte: now },
        },
        {
          status: WebhookEventStatus.FAILED,
          nextRetryAt: { lte: now },
        },
        {
          status: WebhookEventStatus.PROCESSING,
          leaseExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}
