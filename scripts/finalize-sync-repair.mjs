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

  await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
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

  // Clear stale schema-error FAILED jobs so dashboard doesn't keep nagging.
  await p.syncJob.updateMany({
    where: {
      shopId: shop.id,
      status: "FAILED",
      lastError: { contains: "storefrontUrl" },
    },
    data: {
      lastError:
        "Previous sync failed (stale Prisma client). Click Sync products to retry.",
    },
  });

  const live = await p.product.count({
    where: { shopId: shop.id, deletedAt: null },
  });
  const eligible = await p.product.count({
    where: { shopId: shop.id, deletedAt: null, eligible: true },
  });
  const latest = await p.syncJob.findFirst({
    where: { shopId: shop.id, type: "PRODUCTS" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, lastError: true, updatedAt: true },
  });

  console.log(JSON.stringify({ live, eligible, latest }, null, 2));
} finally {
  await p.$disconnect();
}
