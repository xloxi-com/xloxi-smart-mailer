/**
 * Signed unsubscribe URLs + one-click (RFC 8058) handling.
 * Syncs UNSUBSCRIBED to Shopify via existing consent helpers — never resubscribes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Subscriber } from "@prisma/client";
import prisma from "../db.server";
import { getShopifyAppEnv } from "../lib/env.server";
import { logger } from "../lib/logging.server";
import {
  MarketingConsentState,
  SuppressionReason,
} from "../lib/prisma.server";
import {
  applySuppression,
  handleExternalUnsubscribe,
  normalizeEmail,
} from "./consent.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export type UnsubscribeTokenPayload = {
  shopId: string;
  subscriberId: string;
  emailHash: string;
  exp: number;
};

function signingSecret(): string {
  const dedicated = process.env.UNSUBSCRIBE_SIGNING_SECRET?.trim();
  if (dedicated) return dedicated;

  const shopifySecret = getShopifyAppEnv().SHOPIFY_API_SECRET?.trim();
  if (shopifySecret) return shopifySecret;

  if (
    process.env.NODE_ENV === "production" ||
    process.env.UNSUBSCRIBE_REQUIRE_SECRET === "true"
  ) {
    throw new Error(
      "UNSUBSCRIBE_SIGNING_SECRET (or SHOPIFY_API_SECRET) is required",
    );
  }

  // Local/dev only — never used when NODE_ENV=production.
  return "dev-only-unsubscribe-secret";
}

function emailHash(emailNormalized: string): string {
  return createHmac("sha256", signingSecret())
    .update(`email:${emailNormalized}`)
    .digest("hex")
    .slice(0, 24);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function signPayload(payload: UnsubscribeTokenPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", signingSecret()).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

export function verifyUnsubscribeToken(
  token: string,
): UnsubscribeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = createHmac("sha256", signingSecret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      fromB64url(body).toString("utf8"),
    ) as UnsubscribeTokenPayload;
    if (!payload.shopId || !payload.subscriberId || !payload.emailHash) {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Build HTTPS unsubscribe URL for email footers and List-Unsubscribe.
 */
export function buildSignedUnsubscribeUrl(options: {
  appUrl: string;
  shopId: string;
  subscriberId: string;
  emailNormalized: string;
  ttlSeconds?: number;
}): string {
  const exp =
    Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const token = signPayload({
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    emailHash: emailHash(normalizeEmail(options.emailNormalized)),
    exp,
  });
  const base = options.appUrl.replace(/\/+$/, "");
  return `${base}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** RFC 8058 one-click List-Unsubscribe headers. */
export function buildListUnsubscribeHeaders(unsubscribeUrl: string): Record<
  string,
  string
> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export async function processUnsubscribeToken(options: {
  token: string;
  client?: AdminGraphqlClient | null;
  shopDomain?: string | null;
  source?: string;
}): Promise<
  | { ok: true; subscriberId: string; shopId: string }
  | { ok: false; reason: string }
> {
  const payload = verifyUnsubscribeToken(options.token);
  if (!payload) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }

  const subscriber = await prisma.subscriber.findFirst({
    where: {
      id: payload.subscriberId,
      shopId: payload.shopId,
      deletedAt: null,
    },
  });
  if (!subscriber) {
    return { ok: false, reason: "subscriber_not_found" };
  }

  const expectedHash = emailHash(subscriber.emailNormalized);
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(payload.emailHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "email_hash_mismatch" };
  }

  const shop = await prisma.shop.findUnique({ where: { id: payload.shopId } });
  if (!shop) {
    return { ok: false, reason: "shop_not_found" };
  }

  if (options.client && (options.shopDomain || shop.shopDomain)) {
    await handleExternalUnsubscribe({
      shopId: shop.id,
      shopDomain: options.shopDomain || shop.shopDomain,
      subscriber,
      client: options.client,
      source: options.source ?? "signed_unsubscribe",
    });
  } else {
    await applyLocalUnsubscribeOnly(subscriber, options.source ?? "signed_unsubscribe");
  }

  logger.info("unsubscribe_processed", {
    shopId: shop.id,
    subscriberId: subscriber.id,
    source: options.source ?? "signed_unsubscribe",
  });

  return { ok: true, subscriberId: subscriber.id, shopId: shop.id };
}

async function applyLocalUnsubscribeOnly(
  subscriber: Subscriber,
  source: string,
): Promise<void> {
  await applySuppression({
    shopId: subscriber.shopId,
    subscriberId: subscriber.id,
    emailNormalized: subscriber.emailNormalized,
    reason: SuppressionReason.UNSUBSCRIBED,
    source,
  });
  await prisma.subscriber.update({
    where: { id: subscriber.id },
    data: {
      marketingConsentState: MarketingConsentState.UNSUBSCRIBED,
      eligible: false,
      isSuppressed: true,
      nextEmailAt: null,
      consentUpdatedAt: new Date(),
    },
  });
}

/**
 * Parse one-click POST body (application/x-www-form-urlencoded).
 */
export async function extractOneClickToken(
  request: Request,
): Promise<string | null> {
  const urlToken = new URL(request.url).searchParams.get("token");
  if (urlToken) return urlToken;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const listed = form.get("List-Unsubscribe");
    // Some MUAs POST with token still in query; body may only be One-Click marker.
    if (typeof listed === "string" && listed.includes("token=")) {
      try {
        const u = new URL(listed.replace(/^<|>$/g, ""));
        return u.searchParams.get("token");
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
