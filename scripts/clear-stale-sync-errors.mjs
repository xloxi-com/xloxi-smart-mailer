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

  // Hide ancient storefrontUrl noise from the dashboard banner.
  const cleaned = await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      OR: [
        { lastError: { contains: "storefrontUrl" } },
        { lastError: { contains: "Unknown argument" } },
        { lastError: { contains: "Cancelled stuck" } },
      ],
    },
    data: { lastError: null },
  });

  const live = await p.product.count({
    where: { shopId: shop.id, deletedAt: null },
  });

  console.log(
    JSON.stringify(
      { cancelled: cancelled.count, cleaned: cleaned.count, live },
      null,
      2,
    ),
  );
} finally {
  await p.$disconnect();
}
