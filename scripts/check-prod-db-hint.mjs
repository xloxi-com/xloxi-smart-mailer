import { PrismaClient } from "@prisma/client";

// Compare pooler vs direct — same project should see same counts.
const urls = [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["DIRECT_URL", process.env.DIRECT_URL],
].filter(([, u]) => Boolean(u));

for (const [name, url] of urls) {
  const p = new PrismaClient({ datasources: { db: { url } } });
  try {
    const shop = await p.shop.findUnique({
      where: { shopDomain: "offrefy-qzj4kjnw.myshopify.com" },
      select: { id: true },
    });
    const live = shop
      ? await p.product.count({ where: { shopId: shop.id, deletedAt: null } })
      : -1;
    const running = shop
      ? await p.syncJob.count({
          where: {
            shopId: shop.id,
            status: { in: ["PENDING", "RUNNING"] },
          },
        })
      : -1;
    console.log(JSON.stringify({ name, live, running, shopId: shop?.id }));
  } catch (e) {
    console.log(JSON.stringify({ name, error: e.message }));
  } finally {
    await p.$disconnect();
  }
}
