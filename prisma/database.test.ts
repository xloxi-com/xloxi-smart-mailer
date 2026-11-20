import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
  Prisma,
} from "@prisma/client";

const prisma = new PrismaClient();
const TEST_SHOP = "db-test.myshopify.com";

async function cleanupTestShop() {
  // WebhookEvent.shopId is SetNull on shop delete — clear by domain explicitly.
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: TEST_SHOP } });
  await prisma.auditLog.deleteMany({
    where: { shop: { shopDomain: TEST_SHOP } },
  });
  await prisma.shop.deleteMany({ where: { shopDomain: TEST_SHOP } });
}

describe("database architecture", () => {
  beforeAll(async () => {
    await cleanupTestShop();
  });

  afterAll(async () => {
    await cleanupTestShop();
    await prisma.$disconnect();
  });

  it("creates shop with AutomationSettings defaults", async () => {
    const shop = await prisma.shop.create({
      data: {
        shopDomain: TEST_SHOP,
        name: "DB Test Shop",
        automationSettings: { create: {} },
      },
      include: { automationSettings: true },
    });

    const s = shop.automationSettings!;
    expect(s.automationEnabled).toBe(false);
    expect(s.intervalDays).toBe(3);
    expect(s.productsPerEmail).toBe(6);
    expect(s.randomSelection).toBe(true);
    expect(s.inStockOnly).toBe(true);
    expect(s.preventDuplicates).toBe(true);
    expect(s.autoResetCycle).toBe(true);
    expect(s.dryRun).toBe(true);
  });

  it("enforces ProductHistory unique (shop, subscriber, product, cycle)", async () => {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { shopDomain: TEST_SHOP },
    });

    const product = await prisma.product.create({
      data: {
        shopId: shop.id,
        shopifyProductGid: "gid://shopify/Product/db-test-1",
        title: "Test Product",
        status: "ACTIVE",
        publishedToOnlineStore: true,
        inStock: true,
        eligible: true,
      },
    });

    const subscriber = await prisma.subscriber.create({
      data: {
        shopId: shop.id,
        shopifyCustomerGid: "gid://shopify/Customer/db-test-1",
        email: "db.test@example.com",
        emailNormalized: "db.test@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
        currentCycleNumber: 1,
        nextEmailAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    await prisma.productHistory.create({
      data: {
        shopId: shop.id,
        subscriberId: subscriber.id,
        productId: product.id,
        cycleNumber: 1,
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    await expect(
      prisma.productHistory.create({
        data: {
          shopId: shop.id,
          subscriberId: subscriber.id,
          productId: product.id,
          cycleNumber: 1,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("enforces EmailJob idempotency and stores lease/retry fields", async () => {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { shopDomain: TEST_SHOP },
    });
    const subscriber = await prisma.subscriber.findFirstOrThrow({
      where: { shopId: shop.id },
    });
    const product = await prisma.product.findFirstOrThrow({
      where: { shopId: shop.id },
    });

    const job = await prisma.emailJob.create({
      data: {
        shopId: shop.id,
        subscriberId: subscriber.id,
        idempotencyKey: "test-idem-1",
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        attemptCount: 0,
        maxAttempts: 5,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRetryAt: null,
        dryRun: true,
        productSnapshot: { products: [{ id: product.id }] },
        products: {
          create: [
            {
              shopId: shop.id,
              productId: product.id,
              position: 0,
              shopifyProductGid: product.shopifyProductGid,
              title: product.title,
            },
          ],
        },
      },
      include: { products: true },
    });

    expect(job.status).toBe(EmailJobStatus.PENDING);
    expect(job.products).toHaveLength(1);

    await expect(
      prisma.emailJob.create({
        data: {
          shopId: shop.id,
          subscriberId: subscriber.id,
          idempotencyKey: "test-idem-1",
          cycleNumber: 1,
          productSnapshot: {},
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const claimed = await prisma.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.PROCESSING,
        attemptCount: { increment: 1 },
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
        processingStartedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    expect(claimed.attemptCount).toBe(1);
    expect(claimed.leaseOwner).toBe("worker-1");
  });

  it("dedupes webhook events by webhookId", async () => {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { shopDomain: TEST_SHOP },
    });
    const webhookId = `wh-test-${Date.now()}`;

    await prisma.webhookEvent.create({
      data: {
        shopId: shop.id,
        shopDomain: TEST_SHOP,
        topic: "products/update",
        webhookId,
        apiVersion: "2026-10",
      },
    });

    await expect(
      prisma.webhookEvent.create({
        data: {
          shopId: shop.id,
          shopDomain: TEST_SHOP,
          topic: "products/update",
          webhookId,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("indexes support due-subscriber and pending-job queries", async () => {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { shopDomain: TEST_SHOP },
    });

    const due = await prisma.subscriber.findMany({
      where: {
        shopId: shop.id,
        eligible: true,
        isSuppressed: false,
        nextEmailAt: { lte: new Date("2030-01-01T00:00:00.000Z") },
      },
      orderBy: { nextEmailAt: "asc" },
      take: 50,
    });
    expect(due.length).toBeGreaterThan(0);

    // One-active-job partial unique index: close any active job before enqueueing.
    await prisma.emailJob.updateMany({
      where: {
        shopId: shop.id,
        subscriberId: due[0]!.id,
        status: {
          in: [
            EmailJobStatus.PENDING,
            EmailJobStatus.PROCESSING,
            EmailJobStatus.RETRY_SCHEDULED,
            EmailJobStatus.UNKNOWN,
          ],
        },
      },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
      },
    });

    await prisma.emailJob.create({
      data: {
        shopId: shop.id,
        subscriberId: due[0]!.id,
        idempotencyKey: "test-idem-pending-query",
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        runAt: new Date("2026-01-02T00:00:00.000Z"),
        dryRun: true,
        productSnapshot: {},
      },
    });

    // Second active job for same subscriber must fail (partial unique index).
    await expect(
      prisma.emailJob.create({
        data: {
          shopId: shop.id,
          subscriberId: due[0]!.id,
          idempotencyKey: "test-idem-pending-query-2",
          status: EmailJobStatus.PENDING,
          cycleNumber: 1,
          productSnapshot: {},
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const pending = await prisma.emailJob.findMany({
      where: {
        shopId: shop.id,
        status: { in: [EmailJobStatus.PENDING, EmailJobStatus.RETRY_SCHEDULED] },
        runAt: { lte: new Date("2030-01-01T00:00:00.000Z") },
      },
      orderBy: { runAt: "asc" },
      take: 50,
    });
    expect(pending.length).toBeGreaterThan(0);

    const eligibleProducts = await prisma.product.findMany({
      where: {
        shopId: shop.id,
        eligible: true,
        deletedAt: null,
      },
      take: 50,
    });
    expect(eligibleProducts.length).toBeGreaterThan(0);
  });
});
