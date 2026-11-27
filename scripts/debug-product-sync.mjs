import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

try {
  const shops = await p.shop.findMany({
    select: {
      id: true,
      shopDomain: true,
      lastSyncAt: true,
      automationSettings: { select: { inStockOnly: true } },
    },
  });
  console.log("shops:", JSON.stringify(shops, null, 2));

  for (const shop of shops) {
    const productCount = await p.product.count({ where: { shopId: shop.id } });
    const liveCount = await p.product.count({
      where: { shopId: shop.id, deletedAt: null },
    });
    const jobs = await p.syncJob.findMany({
      where: { shopId: shop.id, type: { in: ["PRODUCTS", "FULL"] } },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: {
        id: true,
        status: true,
        lastError: true,
        stats: true,
        updatedAt: true,
        completedAt: true,
        cursor: true,
      },
    });
    console.log(
      JSON.stringify(
        {
          shop: shop.shopDomain,
          productCount,
          liveCount,
          jobs,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await p.$disconnect();
}
