import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  extractOneClickToken,
  processUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../services/unsubscribe.server";

/**
 * Signed unsubscribe endpoint (GET confirm / POST one-click).
 * Does not send email. Syncs to Shopify when an offline session exists.
 */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.method === "POST" ? await extractOneClickToken(request) : null);

  if (!token) {
    return new Response("Missing unsubscribe token", { status: 400 });
  }

  let client = null;
  let shopDomain: string | null = null;
  const payload = verifyUnsubscribeToken(token);
  if (payload) {
    const shop = await prisma.shop.findUnique({
      where: { id: payload.shopId },
    });
    shopDomain = shop?.shopDomain ?? null;
    if (shopDomain && !shop?.uninstalledAt) {
      try {
        const { getOfflineAdmin } = await import(
          "../shopify/offline-admin.server"
        );
        const offline = await getOfflineAdmin(shopDomain);
        client = offline.admin;
      } catch {
        client = null;
      }
    }
  }

  const result = await processUnsubscribeToken({
    token,
    client,
    shopDomain,
    source:
      request.method === "POST" ? "one_click_unsubscribe" : "unsubscribe_link",
  });

  if (!result.ok) {
    logger.warn("unsubscribe_rejected", { reason: result.reason });
    return new Response("Unable to process unsubscribe", { status: 400 });
  }

  if (request.method === "POST") {
    return new Response(null, { status: 200 });
  }

  return new Response(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;">
      <h1>You have been unsubscribed</h1>
      <p>You will no longer receive marketing emails from this list.</p>
    </body></html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  handle(request);
export const action = async ({ request }: ActionFunctionArgs) =>
  handle(request);
