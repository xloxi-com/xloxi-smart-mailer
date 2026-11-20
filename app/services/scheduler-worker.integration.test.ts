/**
 * Scheduler tests for Messaging/Flow architecture.
 * Scheduler only tags due subscribers when appSchedulerEnabled=true.
 * Email worker is disabled (no direct delivery).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import {
  buildScheduleIdempotencyKey,
  runEmailScheduler,
} from "./scheduler.server";
import {
  DURABLE_LOCKS,
  releaseDurableLock,
  tryDurableLock,
} from "./job-queue.server";
import { runEmailWorker } from "./email-worker.server";

const prisma = new PrismaClient();
const SHOP = `sched-worker-${process.pid}.myshopify.com`;

describe("scheduler (Flow request tagging)", () => {
  let shopId: string;
  let subscriberId: string;

  beforeAll(async () => {
    process.env.EMAIL_SENDING_ENABLED = "false";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "test-key";
    process.env.SHOPIFY_API_SECRET =
      process.env.SHOPIFY_API_SECRET || "test-secret";

    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: {
          create: {
            automationEnabled: true,
            appSchedulerEnabled: true,
            dryRun: true,
            testMode: true,
            intervalDays: 3,
            productsPerEmail: 6,
            maxEmailsPerRun: 20,
            emailProviderLabel: "shopify_messaging",
          },
        },
      },
    });
    shopId = shop.id;

    const sub = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/sched-1",
        email: "sched@example.com",
        emailNormalized: "sched@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
        isSuppressed: false,
        nextEmailAt: new Date("2020-01-01T00:00:00.000Z"),
        currentCycleNumber: 1,
        pendingBatchId: null,
      },
    });
    subscriberId = sub.id;
  });

  beforeEach(async () => {
    await prisma.emailJob.deleteMany({ where: { shopId } });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        eligible: true,
        isSuppressed: false,
        paused: false,
        pendingBatchId: null,
        nextEmailAt: new Date("2020-01-01T00:00:00.000Z"),
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      },
    });
    await prisma.automationSettings.update({
      where: { shopId },
      data: {
        automationEnabled: true,
        appSchedulerEnabled: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("builds deterministic Flow request idempotency keys", () => {
    const at = new Date("2020-01-01T00:00:00.000Z");
    expect(buildScheduleIdempotencyKey(subscriberId, at)).toBe(
      `flow-request:${subscriberId}:${at.toISOString()}`,
    );
  });

  it("skips shops without appSchedulerEnabled", async () => {
    await prisma.automationSettings.update({
      where: { shopId },
      data: { appSchedulerEnabled: false },
    });
    const result = await runEmailScheduler({ shopId });
    expect(result.locked).toBe(true);
    expect(result.shops).toHaveLength(0);
  });

  it("skips overlapping scheduler locks", async () => {
    const locked = await tryDurableLock({
      lockId: DURABLE_LOCKS.scheduler,
      owner: "holder",
      ttlMs: 60_000,
    });
    expect(locked).toBe(true);
    try {
      const result = await runEmailScheduler({
        shopId,
        workerId: "challenger",
      });
      expect(result.locked).toBe(false);
    } finally {
      await releaseDurableLock({
        lockId: DURABLE_LOCKS.scheduler,
        owner: "holder",
      });
    }
  });

  it("does not create EmailJob rows (Messaging-only)", async () => {
    // Without offline Admin session, tagging may error — but must not enqueue sends.
    await runEmailScheduler({ shopId });
    expect(await prisma.emailJob.count({ where: { shopId } })).toBe(0);
  });

  it("email worker is a no-op without legacy flag", async () => {
    delete process.env.XLOXI_ALLOW_LEGACY_EMAIL_WORKER;
    const result = await runEmailWorker({ shopId, maxRuntimeMs: 1_000 });
    expect(result.metrics.claimed).toBe(0);
    expect(result.metrics.accepted).toBe(0);
  });
});
