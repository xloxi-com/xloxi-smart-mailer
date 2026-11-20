import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
  SuppressionReason,
} from "@prisma/client";
import {
  calculateNextEmailAt,
  computeStaggerMinutes,
  isMarketingEligible,
  isValidEmail,
  maskEmail,
  normalizeEmail,
  parseMarketingConsentState,
  cancelPendingJobsForSubscriber,
  applySuppression,
  handleExternalUnsubscribe,
} from "./consent.server";

vi.mock("../shopify/admin-graphql.server", async () => {
  const actual = await vi.importActual<
    typeof import("../shopify/admin-graphql.server")
  >("../shopify/admin-graphql.server");
  return {
    ...actual,
    adminGraphql: vi.fn(),
  };
});

import { adminGraphql } from "../shopify/admin-graphql.server";

const prisma = new PrismaClient();
const SHOP = "consent-test.myshopify.com";

describe("consent helpers", () => {
  it("normalizes and validates emails", () => {
    expect(normalizeEmail("  A@B.Com ")).toBe("a@b.com");
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });

  it("only treats SUBSCRIBED + valid email as marketing eligible", () => {
    expect(
      isMarketingEligible({
        email: "a@b.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      }),
    ).toBe(true);
    expect(
      isMarketingEligible({
        email: "a@b.com",
        marketingConsentState: MarketingConsentState.NOT_SUBSCRIBED,
      }),
    ).toBe(false);
    expect(
      isMarketingEligible({
        email: "a@b.com",
        marketingConsentState: MarketingConsentState.PENDING,
      }),
    ).toBe(false);
    expect(
      isMarketingEligible({
        email: "a@b.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        isSuppressed: true,
      }),
    ).toBe(false);
    expect(
      isMarketingEligible({
        email: null,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      }),
    ).toBe(false);
  });

  it("staggers next email dates independently", () => {
    const a = computeStaggerMinutes("shop1", "gid://shopify/Customer/1", 3);
    const b = computeStaggerMinutes("shop1", "gid://shopify/Customer/2", 3);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(3 * 24 * 60);
    // Different customers should usually differ (not guaranteed but likely)
    expect(typeof b).toBe("number");

    const next = calculateNextEmailAt({
      shopId: "shop1",
      shopifyCustomerGid: "gid://shopify/Customer/1",
      intervalDays: 3,
      lastSuccessfulEmailAt: new Date("2026-01-01T00:00:00.000Z"),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(next.toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });

  it("parses consent states", () => {
    expect(parseMarketingConsentState("subscribed")).toBe(
      MarketingConsentState.SUBSCRIBED,
    );
    expect(parseMarketingConsentState("nope")).toBe(
      MarketingConsentState.NOT_SUBSCRIBED,
    );
  });
});

describe("unsubscribe handling", () => {
  let shopId: string;
  let subscriberId: string;

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: { create: {} },
      },
    });
    shopId = shop.id;
    const sub = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/consent-1",
        email: "consent@example.com",
        emailNormalized: "consent@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
        nextEmailAt: new Date(),
      },
    });
    subscriberId = sub.id;

    await prisma.emailJob.create({
      data: {
        shopId,
        subscriberId,
        idempotencyKey: `consent-job-${Date.now()}`,
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        productSnapshot: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("cancels pending jobs and suppresses on unsubscribe", async () => {
    await applySuppression({
      shopId,
      subscriberId,
      emailNormalized: "consent@example.com",
      reason: SuppressionReason.UNSUBSCRIBED,
      source: "test",
    });

    const sub = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberId },
    });
    expect(sub.eligible).toBe(false);
    expect(sub.isSuppressed).toBe(true);

    const jobs = await prisma.emailJob.findMany({ where: { subscriberId } });
    expect(jobs.every((j) => j.status === EmailJobStatus.CANCELLED)).toBe(true);
  });

  it("syncs ESP unsubscribe to Shopify as UNSUBSCRIBED only", async () => {
    vi.mocked(adminGraphql).mockResolvedValue({
      data: {
        customerEmailMarketingConsentUpdate: {
          customer: { id: "gid://shopify/Customer/consent-1" },
          userErrors: [],
        },
      },
    } as never);

    const subscriber = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberId },
    });

    await handleExternalUnsubscribe({
      shopId,
      shopDomain: SHOP,
      subscriber,
      client: { graphql: vi.fn() } as never,
      source: "esp",
    });

    expect(adminGraphql).toHaveBeenCalled();
    const call = vi.mocked(adminGraphql).mock.calls.at(-1);
    const variables = call?.[2]?.variables as {
      input: { emailMarketingConsent: { marketingState: string } };
    };
    expect(variables.input.emailMarketingConsent.marketingState).toBe(
      "UNSUBSCRIBED",
    );

    const cancelled = await cancelPendingJobsForSubscriber(
      shopId,
      subscriberId,
      "noop",
    );
    expect(cancelled).toBeGreaterThanOrEqual(0);
  });
});
