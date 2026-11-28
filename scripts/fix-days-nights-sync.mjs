import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const p = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

try {
  const shop = await p.shop.findUnique({
    where: { shopDomain: "days-and-nights-3366.myshopify.com" },
  });
  if (!shop) throw new Error("shop missing");

  const cancelled = await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      status: { in: ["PENDING", "RUNNING"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });

  const cleaned = await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      lastError: { contains: "timed out" },
    },
    data: { lastError: null },
  });

  console.log(
    JSON.stringify({ shop: shop.shopDomain, cancelled: cancelled.count, cleaned: cleaned.count }),
  );
} finally {
  await p.$disconnect();
}
