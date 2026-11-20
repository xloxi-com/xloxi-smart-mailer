/**
 * Development-only seed. Refuses to run when NODE_ENV=production.
 */
import { PrismaClient, MarketingConsentState, EmailJobStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed production database");
  }

  const shopDomain = "dev-seed.myshopify.com";

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { name: "XLOXI Dev Seed Shop", timezone: "UTC" },
    create: {
      shopDomain,
      name: "XLOXI Dev Seed Shop",
      timezone: "UTC",
      currencyCode: "USD",
      automationSettings: {
        create: {}, // all AutomationSettings defaults apply
      },
    },
    include: { automationSettings: true },
  });

  if (!shop.automationSettings) {
    await prisma.automationSettings.create({
      data: { shopId: shop.id },
    });
  }

  const product = await prisma.product.upsert({
    where: {
      shopId_shopifyProductGid: {
        shopId: shop.id,
        shopifyProductGid: "gid://shopify/Product/1001",
      },
    },
    update: {
      title: "Seed Product A",
      status: "ACTIVE",
      publishedToOnlineStore: true,
      inStock: true,
      eligible: true,
      totalInventory: 12,
    },
    create: {
      shopId: shop.id,
      shopifyProductGid: "gid://shopify/Product/1001",
      handle: "seed-product-a",
      title: "Seed Product A",
      status: "ACTIVE",
      publishedToOnlineStore: true,
      inStock: true,
      eligible: true,
      totalInventory: 12,
      tracksInventory: true,
      currencyCode: "USD",
      variants: {
        create: [
          {
            shopId: shop.id,
            shopifyVariantGid: "gid://shopify/ProductVariant/2001",
            title: "Default",
            inventoryQuantity: 12,
            tracksInventory: true,
            availableForSale: true,
            price: 29.99,
          },
        ],
      },
    },
  });

  const subscriber = await prisma.subscriber.upsert({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: shop.id,
        shopifyCustomerGid: "gid://shopify/Customer/3001",
      },
    },
    update: {
      email: "seed.subscriber@example.com",
      emailNormalized: "seed.subscriber@example.com",
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      eligible: true,
      isSuppressed: false,
      currentCycleNumber: 1,
      nextEmailAt: new Date(),
    },
    create: {
      shopId: shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/3001",
      email: "seed.subscriber@example.com",
      emailNormalized: "seed.subscriber@example.com",
      marketingConsentState: MarketingConsentState.SUBSCRIBED,
      eligible: true,
      isSuppressed: false,
      currentCycleNumber: 1,
      nextEmailAt: new Date(),
    },
  });

  const idempotencyKey = `seed:${shop.id}:${subscriber.id}:cycle-1`;
  await prisma.emailJob.upsert({
    where: {
      shopId_idempotencyKey: {
        shopId: shop.id,
        idempotencyKey,
      },
    },
    update: {
      status: EmailJobStatus.PENDING,
      dryRun: true,
      productSnapshot: {
        products: [
          {
            productId: product.id,
            shopifyProductGid: product.shopifyProductGid,
            title: product.title,
          },
        ],
      },
    },
    create: {
      shopId: shop.id,
      subscriberId: subscriber.id,
      idempotencyKey,
      status: EmailJobStatus.PENDING,
      cycleNumber: 1,
      dryRun: true,
      productSnapshot: {
        products: [
          {
            productId: product.id,
            shopifyProductGid: product.shopifyProductGid,
            title: product.title,
          },
        ],
      },
      products: {
        create: [
          {
            shopId: shop.id,
            productId: product.id,
            position: 0,
            shopifyProductGid: product.shopifyProductGid,
            title: product.title,
            handle: product.handle,
          },
        ],
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "SYSTEM",
      entityType: "Seed",
      entityId: shop.id,
      actorType: "seed",
      metadata: { note: "development seed applied" },
    },
  });

  console.log(
    JSON.stringify({
      seeded: true,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      productId: product.id,
      subscriberId: subscriber.id,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
