import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const p = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

try {
  const shop = await p.shop.findUnique({
    where: { shopDomain: "offrefy-qzj4kjnw.myshopify.com" },
  });
  if (!shop) throw new Error("shop missing");

  const jobs = await p.syncJob.findMany({
    where: { shopId: shop.id, type: { in: ["PRODUCTS", "FULL"] } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      lastError: true,
      cursor: true,
      updatedAt: true,
      completedAt: true,
      attemptCount: true,
      stats: true,
    },
  });

  const live = await p.product.count({
    where: { shopId: shop.id, deletedAt: null },
  });

  for (const job of jobs) {
    const stats = job.stats && typeof job.stats === "object" ? job.stats : {};
    console.log(
      JSON.stringify(
        {
          id: job.id,
          status: job.status,
          lastError: job.lastError,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
          attemptCount: job.attemptCount,
          cursor: job.cursor ? "set" : null,
          ticks: stats.ticks,
          processed: stats.processed,
          upserted: stats.upserted,
          errors: stats.errors,
          phase: stats.phase,
          hasMore: stats.hasMore,
          shopifyProductCount: stats.shopifyProductCount,
          partialErrors: Array.isArray(stats.partialErrors)
            ? stats.partialErrors.slice(-3)
            : [],
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ liveProducts: live }));
} finally {
  await p.$disconnect();
}
