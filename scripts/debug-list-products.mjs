import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

try {
  const shop = await p.shop.findUnique({
    where: { shopDomain: "offrefy-qzj4kjnw.myshopify.com" },
  });
  console.log("shop:", shop?.id, shop?.shopDomain);

  const where = { shopId: shop.id, deletedAt: null };
  const total = await p.product.count({ where });
  const rows = await p.product.findMany({
    where,
    orderBy: [{ eligible: "desc" }, { title: "asc" }],
    take: 3,
    select: { id: true, title: true, eligible: true },
  });
  console.log({ total, rows });

  // What would a hung sync do? Check if fetchProductsCount would hang —
  // simulate cancel stuck jobs and reset for clean sync.
  const cancelled = await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      status: { in: ["PENDING", "RUNNING"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastError: "Cancelled stuck sync during repair",
    },
  });
  console.log("cancelled stuck:", cancelled.count);
} finally {
  await p.$disconnect();
}
