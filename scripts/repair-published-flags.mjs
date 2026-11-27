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

  const domain = shop.shopDomain;
  const products = await p.product.findMany({
    where: { shopId: shop.id, deletedAt: null, status: "ACTIVE" },
    select: {
      id: true,
      handle: true,
      storefrontUrl: true,
      inStock: true,
      excludedFromAutomation: true,
    },
  });

  let updated = 0;
  for (const product of products) {
    const storefrontUrl =
      product.storefrontUrl ??
      `https://${domain}/products/${product.handle}`;
    const eligible =
      !product.excludedFromAutomation && product.inStock !== false;
    await p.product.update({
      where: { id: product.id },
      data: {
        publishedToOnlineStore: true,
        storefrontUrl,
        eligible,
      },
    });
    updated += 1;
  }

  const eligible = await p.product.count({
    where: { shopId: shop.id, deletedAt: null, eligible: true },
  });
  console.log(JSON.stringify({ repaired: updated, eligible }, null, 2));
} finally {
  await p.$disconnect();
}
