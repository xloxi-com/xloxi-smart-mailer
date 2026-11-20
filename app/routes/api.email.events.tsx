import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { applyProviderDeliveryEvents } from "../services/email-delivery.server";
import { getEmailProvider } from "../services/email-provider.server";

/**
 * Provider delivery webhook ingress.
 * Verifies signature via active EmailProvider, then applies events idempotently.
 * Shop is resolved only from an existing EmailJob.providerMessageId — never from
 * spoofable request headers.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const configured = (process.env.EMAIL_PROVIDER ?? "dry_run").trim().toLowerCase();
  if (
    configured === "mock" &&
    process.env.NODE_ENV === "production" &&
    process.env.EMAIL_ALLOW_MOCK_WEBHOOKS !== "true"
  ) {
    logger.error("email_provider_mock_blocked_in_production", {});
    return new Response("Forbidden", { status: 403 });
  }

  const provider = getEmailProvider({
    forceKind: configured === "mock" ? "mock" : undefined,
  });

  const verified = await provider.verifyWebhook(request.clone());
  if (!verified.ok) {
    logger.warn("email_provider_webhook_rejected", {
      provider: provider.name,
      reason: verified.reason,
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const events = await provider.processDeliveryEvent(request);
  if (events.length === 0) {
    return Response.json({ applied: 0, duplicates: 0 });
  }

  const messageIds = [
    ...new Set(
      events
        .map((e) => e.providerMessageId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (messageIds.length === 0) {
    logger.warn("email_provider_webhook_missing_message_id", {
      provider: provider.name,
      eventCount: events.length,
    });
    return Response.json({ error: "message_id_required" }, { status: 400 });
  }

  const job = await prisma.emailJob.findFirst({
    where: { providerMessageId: { in: messageIds } },
    select: { shopId: true },
  });

  if (!job) {
    logger.warn("email_provider_webhook_shop_unresolved", {
      provider: provider.name,
      eventCount: events.length,
    });
    return Response.json({ error: "shop_unresolved" }, { status: 400 });
  }

  const shop = await prisma.shop.findUnique({ where: { id: job.shopId } });
  if (!shop) {
    return Response.json({ error: "shop_unresolved" }, { status: 400 });
  }

  const result = await applyProviderDeliveryEvents(shop.id, events);
  return Response.json(result);
};
