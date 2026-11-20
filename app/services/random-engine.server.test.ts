import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import {
  claimEmailJob,
  markEmailJobAccepted,
  markEmailJobUnknown,
  revalidateJobProductsBeforeFirstSend,
  reserveEmailBatch,
  scheduleEmailJobRetry,
} from "./email-reservation.server";
import { countEligibleUnsent, DEFAULT_BATCH_SIZE } from "./random-engine.server";
import { countHistoryInCycle } from "./product-history.server";

const prisma = new PrismaClient();
const SHOP = `random-engine-test-${process.pid}.myshopify.com`;

async function cleanup() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const shop = await prisma.shop.findUnique({ where: { shopDomain: SHOP } });
      if (!shop) return;
      // Delete dependent rows in FK-safe order to avoid cascade deadlocks.
      await prisma.productHistory.deleteMany({ where: { shopId: shop.id } });
      await prisma.emailJobProduct.deleteMany({ where: { shopId: shop.id } });
      await prisma.emailEvent.deleteMany({ where: { shopId: shop.id } });
      await prisma.emailJob.deleteMany({ where: { shopId: shop.id } });
      await prisma.productVariant.deleteMany({ where: { shopId: shop.id } });
      await prisma.product.deleteMany({ where: { shopId: shop.id } });
      await prisma.subscriber.deleteMany({ where: { shopId: shop.id } });
      await prisma.automationSettings.deleteMany({ where: { shopId: shop.id } });
      await prisma.shop.deleteMany({ where: { id: shop.id } });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("deadlock") && !message.includes("40P01")) throw error;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
}

async function createShop() {
  return prisma.shop.create({
    data: {
      shopDomain: SHOP,
      name: "Random Engine Test",
      automationSettings: { create: { productsPerEmail: 6, inStockOnly: true } },
    },
  });
}

async function createSubscriber(
  shopId: string,
  suffix: string,
  overrides?: { currentCycleNumber?: number },
) {
  return prisma.subscriber.create({
    data: {
      shopId,
      shopifyCustomerGid: `gid://shopify/Customer/re-${suffix}`,
      email: `re-${suffix}@example.com`,
      emailNormalized: `re-${suffix}@example.com`,
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      eligible: true,
      isSuppressed: false,
      currentCycleNumber: overrides?.currentCycleNumber ?? 1,
      nextEmailAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

async function seedProducts(
  shopId: string,
  count: number,
  opts?: { eligible?: boolean; inStock?: boolean; prefix?: string },
) {
  const eligible = opts?.eligible !== false;
  const inStock = opts?.inStock !== false;
  const prefix = opts?.prefix ?? "p";

  // Fast path for large catalogs: single SQL generate_series insert.
  if (count >= 1_000) {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "Product" (
        id, "shopId", "shopifyProductGid", title, handle, status,
        "publishedToOnlineStore", "storefrontUrl", "totalInventory",
        "tracksInventory", "inStock", eligible, "currencyCode",
        "lastSyncedAt", "createdAt", "updatedAt"
      )
      SELECT
        md5($1 || '-' || g::text),
        $1,
        'gid://shopify/Product/' || $2 || '-' || g::text,
        'Product ' || $2 || '-' || g::text,
        $2 || '-' || g::text,
        'ACTIVE',
        true,
        'https://example.com/products/' || $2 || '-' || g::text,
        $3::int,
        true,
        $4::boolean,
        $5::boolean,
        'USD',
        NOW(),
        NOW(),
        NOW()
      FROM generate_series(0, $6::int - 1) AS g
      `,
      shopId,
      prefix,
      inStock ? 5 : 0,
      inStock,
      eligible && inStock,
      count,
    );
    const products = await prisma.product.findMany({
      where: {
        shopId,
        shopifyProductGid: { startsWith: `gid://shopify/Product/${prefix}-` },
      },
      select: { id: true },
      take: Math.min(count, 50),
    });
    return products.map((p) => p.id);
  }

  const rows = Array.from({ length: count }, (_, idx) => ({
    shopId,
    shopifyProductGid: `gid://shopify/Product/${prefix}-${idx}`,
    title: `Product ${prefix}-${idx}`,
    handle: `${prefix}-${idx}`,
    status: "ACTIVE",
    publishedToOnlineStore: true,
    storefrontUrl: `https://example.com/products/${prefix}-${idx}`,
    totalInventory: inStock ? 5 : 0,
    tracksInventory: true,
    inStock,
    eligible: eligible && inStock,
    imageUrl: null as string | null,
    priceMin: 10,
    priceMax: 10,
    currencyCode: "USD",
  }));
  await prisma.product.createMany({ data: rows });
  const products = await prisma.product.findMany({
    where: {
      shopId,
      shopifyProductGid: { startsWith: `gid://shopify/Product/${prefix}-` },
    },
    select: { id: true },
    orderBy: { shopifyProductGid: "asc" },
  });
  return products.map((p) => p.id);
}

describe("random engine + email reservation", () => {
  let shopId: string;

  beforeAll(async () => {
    await cleanup();
    const shop = await createShop();
    shopId = shop.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function wipeCatalogAndJobs() {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ProductHistory" WHERE "shopId" = $1`,
      shopId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EmailJobProduct" WHERE "shopId" = $1`,
      shopId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EmailEvent" WHERE "shopId" = $1`,
      shopId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EmailJob" WHERE "shopId" = $1`,
      shopId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Product" WHERE "shopId" = $1`,
      shopId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Subscriber" WHERE "shopId" = $1`,
      shopId,
    );
  }

  async function reserveAndAccept(subscriberId: string, key: string) {
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: key,
      dryRun: true,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = await claimEmailJob(reserved.job.id, "test-worker");
    expect(claimed).not.toBeNull();
    const accepted = await markEmailJobAccepted(reserved.job.id, {
      providerMessageId: `msg-${key}`,
      providerName: "noop",
    });
    return { reserved, accepted };
  }

  describe.each([0, 1, 5, 6, 7, 20, 100])(
    "catalog size %i",
    (catalogSize) => {
      it(`selects a valid batch for ${catalogSize} products`, async () => {
        await wipeCatalogAndJobs();
        if (catalogSize > 0) {
          await seedProducts(shopId, catalogSize, { prefix: `c${catalogSize}` });
        }
        const sub = await createSubscriber(shopId, `size-${catalogSize}`);

        const result = await reserveEmailBatch({
          shopId,
          subscriberId: sub.id,
          idempotencyKey: `size-${catalogSize}-${Date.now()}`,
        });

        if (catalogSize === 0) {
          expect(result.status).toBe("skipped_no_products");
          return;
        }

        expect(result.status).toBe("reserved");
        if (result.status !== "reserved") return;

        const expected = Math.min(DEFAULT_BATCH_SIZE, catalogSize);
        expect(result.job.products).toHaveLength(expected);
        const ids = result.job.products.map((p) => p.productId);
        expect(new Set(ids).size).toBe(ids.length);
      });
    },
  );

  it(
    "handles 100_000 products without loading the catalog into memory",
    async () => {
      await wipeCatalogAndJobs();
      await seedProducts(shopId, 100_000, { prefix: "big" });
      const sub = await createSubscriber(shopId, "size-100k");

      const remaining = await countEligibleUnsent(prisma, {
        shopId,
        subscriberId: sub.id,
        cycleNumber: 1,
      });
      expect(remaining).toBe(100_000);

      const result = await reserveEmailBatch({
        shopId,
        subscriberId: sub.id,
        idempotencyKey: `size-100k-${Date.now()}`,
      });
      expect(result.status).toBe("reserved");
      if (result.status !== "reserved") return;
      expect(result.job.products).toHaveLength(6);
    },
    180_000,
  );

  it("exhausts a cycle then starts a new one without empty cycles", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 7, { prefix: "cycle" });
    const sub = await createSubscriber(shopId, "cycle-a");

    const first = await reserveAndAccept(sub.id, `cycle-a-1-${Date.now()}`);
    expect(first.reserved.status).toBe("reserved");
    if (first.reserved.status !== "reserved") return;
    expect(first.reserved.job.products).toHaveLength(6);
    expect(first.reserved.job.cycleNumber).toBe(1);

    const hist1 = await countHistoryInCycle(prisma, {
      shopId,
      subscriberId: sub.id,
      cycleNumber: 1,
    });
    expect(hist1).toBe(6);

    const second = await reserveAndAccept(sub.id, `cycle-a-2-${Date.now()}`);
    if (second.reserved.status !== "reserved") {
      throw new Error("expected second reserved");
    }
    expect(second.reserved.job.products).toHaveLength(1);
    expect(second.reserved.job.cycleNumber).toBe(1);
    expect(second.reserved.startedNewCycle).toBe(false);

    const third = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `cycle-a-3-${Date.now()}`,
    });
    expect(third.status).toBe("reserved");
    if (third.status !== "reserved") return;
    expect(third.startedNewCycle).toBe(true);
    expect(third.job.cycleNumber).toBe(2);
    expect(third.job.products).toHaveLength(6);

    const refreshed = await prisma.subscriber.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(refreshed.currentCycleNumber).toBe(2);
  });

  it("does not create empty cycles when no products are eligible", async () => {
    await wipeCatalogAndJobs();
    const sub = await createSubscriber(shopId, "empty-cycle");
    const a = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `empty-1-${Date.now()}`,
    });
    const b = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `empty-2-${Date.now()}`,
    });
    expect(a.status).toBe("skipped_no_products");
    expect(b.status).toBe("skipped_no_products");
    const refreshed = await prisma.subscriber.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(refreshed.currentCycleNumber).toBe(1);
  });

  it("includes newly added eligible products in the current cycle", async () => {
    // Mid-cycle inclusion: send a partial batch, add products, then reserve again.
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 3, { prefix: "mid" });
    const sub2 = await createSubscriber(shopId, "new-products-2");
    await reserveAndAccept(sub2.id, `mid-1-${Date.now()}`);

    await seedProducts(shopId, 4, { prefix: "midnew" });
    const next = await reserveEmailBatch({
      shopId,
      subscriberId: sub2.id,
      idempotencyKey: `mid-2-${Date.now()}`,
    });
    expect(next.status).toBe("reserved");
    if (next.status !== "reserved") return;
    expect(next.startedNewCycle).toBe(false);
    expect(next.job.cycleNumber).toBe(1);
    expect(next.job.products.length).toBeGreaterThanOrEqual(4);
    expect(
      next.job.products.every((p) => p.shopifyProductGid.includes("midnew")),
    ).toBe(true);
  });

  it("excludes deleted, unpublished, and out-of-stock products", async () => {
    await wipeCatalogAndJobs();
    const ids = await seedProducts(shopId, 8, { prefix: "elig" });
    await prisma.product.update({
      where: { id: ids[0] },
      data: { deletedAt: new Date(), eligible: false },
    });
    await prisma.product.update({
      where: { id: ids[1] },
      data: { publishedToOnlineStore: false, storefrontUrl: null, eligible: false },
    });
    await prisma.product.update({
      where: { id: ids[2] },
      data: { inStock: false, eligible: false },
    });

    const sub = await createSubscriber(shopId, "eligibility");
    const result = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `elig-${Date.now()}`,
    });
    expect(result.status).toBe("reserved");
    if (result.status !== "reserved") return;
    expect(result.job.products).toHaveLength(5);
    const selected = new Set(result.job.products.map((p) => p.productId));
    expect(selected.has(ids[0])).toBe(false);
    expect(selected.has(ids[1])).toBe(false);
    expect(selected.has(ids[2])).toBe(false);
  });

  it("preserves history when stock changes", async () => {
    await wipeCatalogAndJobs();
    const ids = await seedProducts(shopId, 6, { prefix: "hist" });
    const sub = await createSubscriber(shopId, "hist-stock");
    await reserveAndAccept(sub.id, `hist-1-${Date.now()}`);

    await prisma.product.update({
      where: { id: ids[0] },
      data: { inStock: false, eligible: false },
    });

    const history = await prisma.productHistory.count({
      where: { shopId, subscriberId: sub.id, productId: ids[0] },
    });
    expect(history).toBe(1);
  });

  it("avoids previous-email products across cycle boundaries when alternatives exist", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 12, { prefix: "boundary" });
    const sub = await createSubscriber(shopId, "boundary");

    const first = await reserveAndAccept(sub.id, `bnd-1-${Date.now()}`);
    if (first.reserved.status !== "reserved") throw new Error("fail");
    const firstIds = new Set(first.reserved.job.products.map((p) => p.productId));

    // Exhaust remaining 6 in cycle 1
    await reserveAndAccept(sub.id, `bnd-2-${Date.now()}`);

    const third = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `bnd-3-${Date.now()}`,
    });
    expect(third.status).toBe("reserved");
    if (third.status !== "reserved") return;
    expect(third.startedNewCycle).toBe(true);
    expect(third.job.cycleNumber).toBe(2);

    // Previous accepted email was the second (last 6 of cycle 1), not first.
    // Soft-exclude applies to the immediately previous email's products.
    const prev = await prisma.emailJob.findFirst({
      where: { shopId, subscriberId: sub.id, status: EmailJobStatus.ACCEPTED },
      orderBy: { completedAt: "desc" },
      include: { products: true },
    });
    const prevIds = new Set(prev!.products.map((p) => p.productId));
    const thirdIds = third.job.products.map((p) => p.productId);
    const overlapPrev = thirdIds.filter((id) => prevIds.has(id));
    expect(overlapPrev).toHaveLength(0);
    void firstIds;
  });

  it("allows different subscribers to receive the same product", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 6, { prefix: "shared" });
    const a = await createSubscriber(shopId, "share-a");
    const b = await createSubscriber(shopId, "share-b");

    const ra = await reserveEmailBatch({
      shopId,
      subscriberId: a.id,
      idempotencyKey: `share-a-${Date.now()}`,
    });
    const rb = await reserveEmailBatch({
      shopId,
      subscriberId: b.id,
      idempotencyKey: `share-b-${Date.now()}`,
    });
    expect(ra.status).toBe("reserved");
    expect(rb.status).toBe("reserved");
    if (ra.status !== "reserved" || rb.status !== "reserved") return;
    expect(ra.job.products.map((p) => p.productId).sort()).toEqual(
      rb.job.products.map((p) => p.productId).sort(),
    );
  });

  it("enforces one active job and reuses batch on concurrent reserve", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 10, { prefix: "conc" });
    const sub = await createSubscriber(shopId, "concurrent");
    const now = Date.now();

    const settled = await Promise.allSettled([
      reserveEmailBatch({
        shopId,
        subscriberId: sub.id,
        idempotencyKey: `conc-a-${now}`,
      }),
      reserveEmailBatch({
        shopId,
        subscriberId: sub.id,
        idempotencyKey: `conc-b-${now + 1}`,
      }),
    ]);

    const results = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveEmailBatch>>>).value);

    // At least one reserve must succeed; the other may observe active_job_exists
    // (or rarely lose the lock race). Final DB state is the source of truth.
    expect(results.length).toBeGreaterThanOrEqual(1);
    const reserved = results.filter((r) => r.status === "reserved");
    const active = results.filter((r) => r.status === "active_job_exists");
    expect(reserved.length + active.length).toBe(results.length);
    expect(reserved.length).toBeLessThanOrEqual(1);

    const jobs = await prisma.emailJob.findMany({
      where: {
        shopId,
        subscriberId: sub.id,
        status: { in: ["PENDING", "PROCESSING", "RETRY_SCHEDULED", "UNKNOWN"] },
      },
    });
    expect(jobs).toHaveLength(1);
  });

  it("reuses the same batch on retry and does not write history until accepted", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 8, { prefix: "retry" });
    const sub = await createSubscriber(shopId, "retry");

    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `retry-1-${Date.now()}`,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    const productIds = reserved.job.products.map((p) => p.productId);
    await claimEmailJob(reserved.job.id, "worker-1");
    await scheduleEmailJobRetry(reserved.job.id, {
      nextRetryAt: new Date(Date.now() + 60_000),
      errorCode: "transient",
      errorMessage: "temporary failure",
    });

    const histBefore = await prisma.productHistory.count({
      where: { shopId, subscriberId: sub.id },
    });
    expect(histBefore).toBe(0);

    const again = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `retry-2-${Date.now()}`,
    });
    expect(again.status).toBe("active_job_exists");
    if (again.status !== "active_job_exists") return;
    expect(again.job.id).toBe(reserved.job.id);
    expect(again.job.products.map((p) => p.productId)).toEqual(productIds);

    await claimEmailJob(reserved.job.id, "worker-2");
    await markEmailJobAccepted(reserved.job.id, { providerMessageId: "ok" });
    const histAfter = await prisma.productHistory.count({
      where: { shopId, subscriberId: sub.id },
    });
    expect(histAfter).toBe(productIds.length);
  });

  it("revalidates and replaces unavailable products before first send", async () => {
    await wipeCatalogAndJobs();
    const ids = await seedProducts(shopId, 10, { prefix: "reval" });
    const sub = await createSubscriber(shopId, "reval");

    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `reval-${Date.now()}`,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    const firstProductId = reserved.job.products[0]!.productId;
    await prisma.product.update({
      where: { id: firstProductId },
      data: { inStock: false, eligible: false },
    });

    const updated = await revalidateJobProductsBeforeFirstSend(reserved.job.id);
    expect(updated.status).not.toBe(EmailJobStatus.CANCELLED);
    expect(updated.products.map((p) => p.productId)).not.toContain(firstProductId);
    expect(updated.products.length).toBe(DEFAULT_BATCH_SIZE);
    expect(new Set(updated.products.map((p) => p.productId)).size).toBe(
      updated.products.length,
    );
    void ids;
  });

  it("marks UNKNOWN on ambiguous timeout and refuses blind retry", async () => {
    await wipeCatalogAndJobs();
    await seedProducts(shopId, 6, { prefix: "unk" });
    const sub = await createSubscriber(shopId, "unknown");

    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId: sub.id,
      idempotencyKey: `unk-${Date.now()}`,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    await claimEmailJob(reserved.job.id, "worker");
    await markEmailJobUnknown(reserved.job.id, {
      code: "provider_timeout",
      message: "no response",
    });

    const hist = await prisma.productHistory.count({
      where: { emailJobId: reserved.job.id },
    });
    expect(hist).toBe(0);

    await expect(
      scheduleEmailJobRetry(reserved.job.id, {
        nextRetryAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow(/unknown/i);
  });
});
