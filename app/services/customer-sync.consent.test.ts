import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import {
  extractConsentFromShopifyCustomer,
  softDeleteSubscriberByGid,
  upsertSubscriberFromShopify,
  type ShopifyCustomerNode,
} from "./customer-sync.server";
import { isMarketingEligible } from "./consent.server";

const prisma = new PrismaClient();
const SHOP = "customer-consent-sync.myshopify.com";

function customerNode(
  overrides?: Partial<ShopifyCustomerNode>,
): ShopifyCustomerNode {
  return {
    id: "gid://shopify/Customer/7001",
    updatedAt: "2026-01-01T00:00:00Z",
    defaultEmailAddress: {
      emailAddress: "sub@example.com",
      marketingState: "SUBSCRIBED",
    },
    emailMarketingConsent: {
      marketingState: "SUBSCRIBED",
      consentUpdatedAt: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

describe("customer sync consent transitions", () => {
  let shopId: string;

  beforeAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: { create: { intervalDays: 3 } },
      },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("extracts consent from 2026-10 customer fields", () => {
    const extracted = extractConsentFromShopifyCustomer(customerNode());
    expect(extracted.email).toBe("sub@example.com");
    expect(extracted.marketingState).toBe(MarketingConsentState.SUBSCRIBED);
    expect(
      isMarketingEligible({
        email: extracted.email,
        marketingConsentState: extracted.marketingState,
      }),
    ).toBe(true);
  });

  it("never marks NOT_SUBSCRIBED customers as eligible", async () => {
    const result = await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({
        id: "gid://shopify/Customer/7002",
        defaultEmailAddress: {
          emailAddress: "plain@example.com",
          marketingState: "NOT_SUBSCRIBED",
        },
        emailMarketingConsent: {
          marketingState: "NOT_SUBSCRIBED",
          consentUpdatedAt: null,
        },
      }),
    });
    expect(result.eligible).toBe(false);
    expect(result.subscriber?.marketingConsentState).toBe(
      MarketingConsentState.NOT_SUBSCRIBED,
    );
  });

  it("cancels pending jobs when consent becomes UNSUBSCRIBED", async () => {
    const created = await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({ id: "gid://shopify/Customer/7003" }),
    });
    expect(created.eligible).toBe(true);
    expect(created.subscriber?.nextEmailAt).not.toBeNull();

    await prisma.emailJob.create({
      data: {
        shopId,
        subscriberId: created.subscriber!.id,
        idempotencyKey: `cust-consent-${Date.now()}`,
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        productSnapshot: {},
      },
    });

    const after = await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({
        id: "gid://shopify/Customer/7003",
        defaultEmailAddress: {
          emailAddress: "sub@example.com",
          marketingState: "UNSUBSCRIBED",
        },
        emailMarketingConsent: {
          marketingState: "UNSUBSCRIBED",
          consentUpdatedAt: "2026-02-01T00:00:00Z",
        },
      }),
    });

    expect(after.eligible).toBe(false);
    const jobs = await prisma.emailJob.findMany({
      where: { subscriberId: created.subscriber!.id },
    });
    expect(jobs.every((j) => j.status === EmailJobStatus.CANCELLED)).toBe(true);
  });

  it("dedupes normalized emails within a shop", async () => {
    await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({
        id: "gid://shopify/Customer/8001",
        defaultEmailAddress: {
          emailAddress: "Same@Example.com",
          marketingState: "SUBSCRIBED",
        },
      }),
    });

    const collision = await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({
        id: "gid://shopify/Customer/8002",
        defaultEmailAddress: {
          emailAddress: "same@example.com",
          marketingState: "SUBSCRIBED",
        },
      }),
    });

    expect(collision.skipped).toBe(true);
    const count = await prisma.subscriber.count({
      where: {
        shopId,
        emailNormalized: "same@example.com",
        deletedAt: null,
      },
    });
    expect(count).toBe(1);
  });

  it("soft-deletes customers without destroying history references", async () => {
    const created = await upsertSubscriberFromShopify({
      shopId,
      intervalDays: 3,
      node: customerNode({
        id: "gid://shopify/Customer/9001",
        defaultEmailAddress: {
          emailAddress: "gone@example.com",
          marketingState: "SUBSCRIBED",
        },
      }),
    });

    const removed = await softDeleteSubscriberByGid(
      shopId,
      "gid://shopify/Customer/9001",
    );
    expect(removed).toBe(true);

    const row = await prisma.subscriber.findUniqueOrThrow({
      where: { id: created.subscriber!.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.eligible).toBe(false);
    expect(row.email).toBe("");
  });
});
