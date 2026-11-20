import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'Product'
      AND column_name = 'storefrontUrl'
  `;
  console.log("column:", JSON.stringify(cols));

  const sample = await prisma.product.findFirst({
    select: { id: true, title: true, storefrontUrl: true },
  });
  console.log("sample:", sample);

  // Probe upsert shape without writing nonsense permanently
  const probe = await prisma.product.findFirst({
    where: { deletedAt: null },
    select: { id: true, shopId: true, shopifyProductGid: true },
  });
  if (probe) {
    await prisma.product.update({
      where: { id: probe.id },
      data: { storefrontUrl: sample?.storefrontUrl ?? null },
    });
    console.log("update_with_storefrontUrl: ok");
  } else {
    console.log("no products to probe");
  }
} catch (error) {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
