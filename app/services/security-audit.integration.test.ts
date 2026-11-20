import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import { setSubscriberPaused } from "./admin-subscribers.server";
import { getEmailJobPreview } from "./admin-email-history.server";
import {
  buildSignedUnsubscribeUrl,
  processUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe.server";
import { action as emailEventsAction } from "../routes/api.email.events";

const prisma = new PrismaClient();
const SHOP_A = `sec-a-${process.pid}.myshopify.com`;
const SHOP_B = `sec-b-${process.pid}.myshopify.com`;

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

describe("security audit", () => {
  let shopAId = "";
  let shopBId = "";
  let subAId = "";
  let subBId = "";
  let jobAId = "";

  beforeAll(async () => {
    process.env.UNSUBSCRIBE_SIGNING_SECRET = "security-audit-secret";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.EMAIL_PROVIDER = "mock";
    process.env.NODE_ENV = "test";

    await prisma.shop.deleteMany({
      where: { shopDomain: { in: [SHOP_A, SHOP_B] } },
    });

    const shopA = await prisma.shop.create({
      data: {
        shopDomain: SHOP_A,
        automationSettings: { create: {} },
      },
    });
    const shopB = await prisma.shop.create({
      data: {
        shopDomain: SHOP_B,
        automationSettings: { create: {} },
      },
    });
    shopAId = shopA.id;
    shopBId = shopB.id;

    const subA = await prisma.subscriber.create({
      data: {
        shopId: shopAId,
        shopifyCustomerGid: "gid://shopify/Customer/sec-a",
        email: "a@example.com",
        emailNormalized: "a@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
      },
    });
    const subB = await prisma.subscriber.create({
      data: {
        shopId: shopBId,
        shopifyCustomerGid: "gid://shopify/Customer/sec-b",
        email: "b@example.com",
        emailNormalized: "b@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
      },
    });
    subAId = subA.id;
    subBId = subB.id;

    const job = await prisma.emailJob.create({
      data: {
        shopId: shopAId,
        subscriberId: subAId,
        idempotencyKey: "sec-job-a",
        status: EmailJobStatus.ACCEPTED,
        cycleNumber: 1,
        productSnapshot: [],
        providerMessageId: "mock_sec_msg_a",
        dryRun: true,
        completedAt: new Date(),
      },
    });
    jobAId = job.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: [SHOP_A, SHOP_B] } },
    });
    await prisma.$disconnect();
  });

  it("blocks cross-shop subscriber pause", async () => {
    const ok = await setSubscriberPaused(shopBId, subAId, true);
    expect(ok).toBe(false);
    const row = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subAId },
    });
    expect(row.paused).toBe(false);
  });

  it("blocks cross-shop email job preview", async () => {
    const preview = await getEmailJobPreview(shopBId, jobAId);
    expect(preview).toBeNull();
  });

  it("rejects tampered unsubscribe tokens", async () => {
    const token = tokenFromUrl(
      buildSignedUnsubscribeUrl({
        appUrl: "https://app.example.com",
        shopId: shopAId,
        subscriberId: subAId,
        emailNormalized: "a@example.com",
      }),
    );
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]!.slice(0, -2)}aa`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();

    const wrongShopToken = tokenFromUrl(
      buildSignedUnsubscribeUrl({
        appUrl: "https://app.example.com",
        shopId: shopBId,
        subscriberId: subAId,
        emailNormalized: "a@example.com",
      }),
    );
    const result = await processUnsubscribeToken({
      token: wrongShopToken,
      source: "test",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects expired unsubscribe tokens", async () => {
    const token = tokenFromUrl(
      buildSignedUnsubscribeUrl({
        appUrl: "https://app.example.com",
        shopId: shopAId,
        subscriberId: subAId,
        emailNormalized: "a@example.com",
        ttlSeconds: -10,
      }),
    );
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects provider webhooks with invalid signatures", async () => {
    const request = new Request("https://app.example.com/api/email/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mock-email-signature": "bad",
      },
      body: JSON.stringify({
        events: [
          {
            id: "evt-1",
            messageId: "mock_sec_msg_a",
            type: "delivered",
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const response = await emailEventsAction({
      request,
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(401);
  });

  it("does not resolve shop from spoofable headers alone", async () => {
    const request = new Request("https://app.example.com/api/email/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mock-email-signature": "mock-ok",
        "x-shopify-shop-domain": SHOP_B,
      },
      body: JSON.stringify({
        events: [
          {
            id: `evt-orphan-${Date.now()}`,
            type: "bounced",
            occurredAt: new Date().toISOString(),
            emailNormalizedHint: "b@example.com",
          },
        ],
      }),
    });
    const response = await emailEventsAction({
      request,
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("message_id_required");
    expect(subBId).toBeTruthy();
  });
});
