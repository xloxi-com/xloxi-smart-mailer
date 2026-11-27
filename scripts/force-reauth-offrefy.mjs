import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const p = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

try {
  const shop = "offrefy-qzj4kjnw.myshopify.com";
  const before = await p.session.findMany({
    where: { shop },
    select: { id: true, scope: true, isOnline: true },
  });
  const deleted = await p.session.deleteMany({ where: { shop } });
  console.log(
    JSON.stringify(
      {
        shop,
        before,
        deleted: deleted.count,
        note: "Next app open will re-authorize with full scopes including read_customers",
      },
      null,
      2,
    ),
  );
} finally {
  await p.$disconnect();
}
