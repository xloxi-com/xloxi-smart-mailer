import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const p = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

try {
  const shops = await p.shop.findMany({
    where: { shopDomain: { contains: "days-and-nights" } },
    select: {
      id: true,
      shopDomain: true,
      lastSyncAt: true,
      automationSettings: { select: { inStockOnly: true } },
    },
  });
  console.log("shops:", JSON.stringify(shops, null, 2));

  for (const shop of shops) {
    const live = await p.product.count({
      where: { shopId: shop.id, deletedAt: null },
    });
    const deleted = await p.product.count({
      where: { shopId: shop.id, deletedAt: { not: null } },
    });
    const jobs = await p.syncJob.findMany({
      where: { shopId: shop.id, type: { in: ["PRODUCTS", "FULL"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        status: true,
        lastError: true,
        updatedAt: true,
        completedAt: true,
        attemptCount: true,
        cursor: true,
        stats: true,
      },
    });
    console.log(
      JSON.stringify(
        {
          shop: shop.shopDomain,
          live,
          deleted,
          jobs: jobs.map((j) => {
            const s = j.stats && typeof j.stats === "object" ? j.stats : {};
            return {
              id: j.id,
              status: j.status,
              lastError: j.lastError,
              updatedAt: j.updatedAt,
              attemptCount: j.attemptCount,
              ticks: s.ticks,
              processed: s.processed,
              errors: s.errors,
              phase: s.phase,
              hasMore: s.hasMore,
              shopifyProductCount: s.shopifyProductCount,
              partialErrors: Array.isArray(s.partialErrors)
                ? s.partialErrors.slice(-2)
                : [],
            };
          }),
        },
        null,
        2,
      ),
    );
  }

  const sessions = await p.session.findMany({
    where: { shop: { contains: "days-and-nights" } },
    select: {
      id: true,
      shop: true,
      isOnline: true,
      scope: true,
      expires: true,
      accessToken: true,
    },
  });
  console.log(
    "sessions:",
    JSON.stringify(
      sessions.map((s) => ({
        id: s.id,
        shop: s.shop,
        isOnline: s.isOnline,
        scope: s.scope,
        expires: s.expires,
        hasToken: Boolean(s.accessToken),
      })),
      null,
      2,
    ),
  );
} finally {
  await p.$disconnect();
}
