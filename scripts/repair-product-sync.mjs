import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const shopDomain = "offrefy-qzj4kjnw.myshopify.com";

try {
  const shop = await p.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    console.error("shop not found");
    process.exit(1);
  }

  const cancelled = await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      type: { in: ["PRODUCTS", "FULL"] },
      status: { in: ["PENDING", "RUNNING"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastError: "Cancelled stuck sync during repair",
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });

  const live = await p.product.count({
    where: { shopId: shop.id, deletedAt: null },
  });
  const eligible = await p.product.count({
    where: { shopId: shop.id, deletedAt: null, eligible: true },
  });

  console.log(
    JSON.stringify(
      { shopDomain, cancelled: cancelled.count, live, eligible },
      null,
      2,
    ),
  );
} finally {
  await p.$disconnect();
}
