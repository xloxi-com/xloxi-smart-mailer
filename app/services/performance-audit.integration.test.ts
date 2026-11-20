import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import { countEligibleUnsent } from "./random-engine.server";
import { reserveEmailBatch } from "./email-reservation.server";
import { listAdminProducts } from "./admin-products.server";
import { listAdminSubscribers } from "./admin-subscribers.server";
import { listEmailHistory } from "./admin-email-history.server";

const prisma = new PrismaClient();
const SHOP = `perf-audit-${process.pid}.myshopify.com`;

/** Default keeps CI/dev fast; set PERF_SCALE=100000 for full catalog stress. */
const PRODUCT_SCALE = Number(process.env.PERF_SCALE ?? "1200");
const SUBSCRIBER_SCALE = Number(
  process.env.PERF_SUBSCRIBER_SCALE ?? Math.min(800, PRODUCT_SCALE),
);
const HISTORY_SCALE = Number(
  process.env.PERF_HISTORY_SCALE ?? Math.min(1500, PRODUCT_SCALE),
);

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
}

describe("performance audit (scaled isolated data)", () => {
  let shopId = "";
  let subscriberId = "";

  beforeAll(async () => {
    await cleanup();
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: {
          create: {
            productsPerEmail: 6,
            inStockOnly: true,
            preventDuplicates: true,
          },
        },
      },
    });
    shopId = shop.id;

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "Product" (
        id, "shopId", "shopifyProductGid", title, handle, status,
        "publishedToOnlineStore", "totalInventory", "tracksInventory",
        "inStock", eligible, "excludedFromAutomation", "currencyCode",
        "lastSyncedAt", "createdAt", "updatedAt"
      )
      SELECT
        md5($1 || '-p-' || g::text),
        $1,
        'gid://shopify/Product/perf-' || g::text,
        'Perf Product ' || g::text,
        'perf-' || g::text,
        'ACTIVE',
        true,
        5,
        true,
        true,
        true,
        false,
        'USD',
        NOW(),
        NOW(),
        NOW()
      FROM generate_series(1, $2::int) AS g
      `,
      shopId,
      PRODUCT_SCALE,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "Subscriber" (
        id, "shopId", "shopifyCustomerGid", email, "emailNormalized",
        "marketingConsentState", "isSuppressed", eligible, paused,
        "currentCycleNumber", "nextEmailAt", "createdAt", "updatedAt"
      )
      SELECT
        md5($1 || '-s-' || g::text),
        $1,
        'gid://shopify/Customer/perf-' || g::text,
        'perf' || g::text || '@example.com',
        'perf' || g::text || '@example.com',
        'SUBSCRIBED',
        false,
        true,
        false,
        1,
        NOW() - interval '1 day',
        NOW(),
        NOW()
      FROM generate_series(1, $2::int) AS g
      `,
      shopId,
      SUBSCRIBER_SCALE,
    );

    const primary = await prisma.subscriber.findFirstOrThrow({
      where: { shopId },
      orderBy: { createdAt: "asc" },
    });
    subscriberId = primary.id;

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "EmailJob" (
        id, "shopId", "subscriberId", "idempotencyKey", status, "cycleNumber",
        "attemptCount", "maxAttempts", "runAt", "productSnapshot", "dryRun",
        "createdAt", "updatedAt"
      )
      SELECT
        md5($1 || '-j-' || g::text),
        $1,
        $2,
        'perf-hist-' || g::text,
        'ACCEPTED',
        1,
        1,
        5,
        NOW() - (g || ' minutes')::interval,
        '[]'::jsonb,
        true,
        NOW() - (g || ' minutes')::interval,
        NOW()
      FROM generate_series(1, $3::int) AS g
      `,
      shopId,
      subscriberId,
      HISTORY_SCALE,
    );
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("counts eligible products with indexed SQL under large catalogs", async () => {
    const started = Date.now();
    const count = await countEligibleUnsent(prisma, {
      shopId,
      subscriberId,
      cycleNumber: 1,
      inStockOnly: true,
    });
    const elapsed = Date.now() - started;
    expect(count).toBe(PRODUCT_SCALE);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("paginates products and subscribers without full-table scans to the client", async () => {
    const started = Date.now();
    const products = await listAdminProducts({
      shopId,
      page: 1,
      pageSize: 25,
    });
    const filtered = await listAdminProducts({
      shopId,
      page: 1,
      pageSize: 25,
      q: "Perf Product 1",
    });
    const subscribers = await listAdminSubscribers({
      shopId,
      page: 1,
      pageSize: 25,
      consent: MarketingConsentState.SUBSCRIBED,
    });
    const elapsed = Date.now() - started;
    expect(products.rows.length).toBe(25);
    expect(products.total).toBe(PRODUCT_SCALE);
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total).toBeLessThan(PRODUCT_SCALE);
    expect(filtered.rows.length).toBeLessThanOrEqual(25);
    expect(subscribers.rows.length).toBeLessThanOrEqual(25);
    expect(subscribers.total).toBe(SUBSCRIBER_SCALE);
    expect(elapsed).toBeLessThan(20_000);
  });

  it("paginates large email history", async () => {
    const started = Date.now();
    const history = await listEmailHistory({
      shopId,
      page: 2,
      pageSize: 50,
      status: EmailJobStatus.ACCEPTED,
    });
    const elapsed = Date.now() - started;
    expect(history.total).toBe(HISTORY_SCALE);
    expect(history.rows).toHaveLength(50);
    expect(elapsed).toBeLessThan(20_000);
  });

  it("reserves a batch against a large catalog without loading all rows", async () => {
    const started = Date.now();
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: `perf-reserve-${Date.now()}`,
      batchSize: 6,
    });
    const elapsed = Date.now() - started;
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    expect(reserved.job.products).toHaveLength(6);
    expect(elapsed).toBeLessThan(20_000);
  });
});
