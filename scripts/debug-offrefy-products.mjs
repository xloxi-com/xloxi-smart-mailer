import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const shopId = "cmwnxedc40000uxf4pd7ann85";

try {
  const cols = await p.$queryRaw`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'Product' AND column_name = 'storefrontUrl'
  `;
  console.log("storefrontUrl column:", cols);

  const counts = await p.product.groupBy({
    by: ["deletedAt"],
    where: { shopId },
    _count: true,
  });
  console.log("counts by deletedAt presence:", counts);

  const deleted = await p.product.count({
    where: { shopId, deletedAt: { not: null } },
  });
  const live = await p.product.count({
    where: { shopId, deletedAt: null },
  });
  console.log({ live, deleted });

  const sample = await p.product.findMany({
    where: { shopId, deletedAt: null },
    take: 5,
    select: {
      title: true,
      eligible: true,
      publishedToOnlineStore: true,
      storefrontUrl: true,
      deletedAt: true,
    },
  });
  console.log("sample live:", sample);

  await p.product.update({
    where: { id: (await p.product.findFirst({ where: { shopId } })).id },
    data: { storefrontUrl: "https://probe.example/test" },
  });
  console.log("storefrontUrl upsert probe: ok");

  const stuck = await p.syncJob.findMany({
    where: {
      shopId,
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { id: true, status: true, updatedAt: true, stats: true },
  });
  console.log("stuck jobs:", stuck);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  await p.$disconnect();
}
