import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  mapShopifyProductToMirror,
  softDeleteProductByGid,
  upsertMirroredProduct,
} from "./product-sync.server";
import type { ShopifyProductNode } from "./shopify-graphql.server";
import { recomputeProductAvailability } from "./inventory-sync.server";

const prisma = new PrismaClient();
const SHOP = "product-sync-test.myshopify.com";

const sampleProduct = (overrides?: Partial<ShopifyProductNode>): ShopifyProductNode => ({
  id: "gid://shopify/Product/9001",
  title: "Sync Test Product",
  handle: "sync-test-product",
  status: "ACTIVE",
  totalInventory: 4,
  tracksInventory: true,
  onlineStoreUrl: "https://example.com/products/sync-test-product",
  updatedAt: "2026-01-01T00:00:00Z",
  featuredImage: { url: "https://cdn.example/p.png" },
  priceRangeV2: {
    minVariantPrice: { amount: "15.00", currencyCode: "USD" },
    maxVariantPrice: { amount: "15.00", currencyCode: "USD" },
  },
  variants: {
    nodes: [
      {
        id: "gid://shopify/ProductVariant/90011",
        title: "Default",
        sku: "ST-1",
        barcode: null,
        price: "15.00",
        compareAtPrice: "20.00",
        inventoryQuantity: 4,
        inventoryPolicy: "DENY",
        availableForSale: true,
        updatedAt: "2026-01-01T00:00:00Z",
        inventoryItem: {
          id: "gid://shopify/InventoryItem/900111",
          tracked: true,
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  ...overrides,
});

describe("product sync integration", () => {
  let shopId: string;

  beforeAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: { create: { inStockOnly: true } },
      },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("maps eligibility using onlineStoreUrl and stock rules", () => {
    const mapped = mapShopifyProductToMirror(sampleProduct(), true);
    expect(mapped.publishedToOnlineStore).toBe(true);
    expect(mapped.storefrontUrl).toContain("sync-test-product");
    expect(mapped.eligible).toBe(true);
    expect(mapped.inStock).toBe(true);

    const unpublished = mapShopifyProductToMirror(
      sampleProduct({ onlineStoreUrl: null }),
      true,
    );
    expect(unpublished.eligible).toBe(false);
  });

  it("upserts product/variants and soft-deletes without removing history rows", async () => {
    await upsertMirroredProduct(shopId, sampleProduct(), true);

    const product = await prisma.product.findFirstOrThrow({
      where: { shopId, shopifyProductGid: "gid://shopify/Product/9001" },
      include: { variants: true },
    });
    expect(product.eligible).toBe(true);
    expect(product.variants[0]?.inventoryItemGid).toContain("InventoryItem");
    expect(product.variants[0]?.price?.toString()).toBe("15");

    // Create a history row that must survive soft delete.
    const subscriber = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/sync-1",
        email: "sync@example.com",
        emailNormalized: "sync@example.com",
      },
    });
    await prisma.productHistory.create({
      data: {
        shopId,
        subscriberId: subscriber.id,
        productId: product.id,
        cycleNumber: 1,
      },
    });

    await softDeleteProductByGid(shopId, product.shopifyProductGid);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.deletedAt).not.toBeNull();
    expect(after.eligible).toBe(false);

    const history = await prisma.productHistory.count({
      where: { productId: product.id },
    });
    expect(history).toBe(1);
  });

  it("recomputes availability after inventory changes", async () => {
    await upsertMirroredProduct(shopId, sampleProduct({
      id: "gid://shopify/Product/9002",
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/90021",
            title: "Default",
            sku: null,
            barcode: null,
            price: "9.00",
            compareAtPrice: null,
            inventoryQuantity: 1,
            inventoryPolicy: "DENY",
            availableForSale: true,
            updatedAt: "2026-01-01T00:00:00Z",
            inventoryItem: {
              id: "gid://shopify/InventoryItem/900211",
              tracked: true,
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }), true);

    const product = await prisma.product.findFirstOrThrow({
      where: { shopId, shopifyProductGid: "gid://shopify/Product/9002" },
      include: { variants: true },
    });

    await prisma.productVariant.update({
      where: { id: product.variants[0]!.id },
      data: { inventoryQuantity: 0, availableForSale: false, price: null },
    });

    await recomputeProductAvailability(shopId, product.id, true);

    const refreshed = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(refreshed.inStock).toBe(false);
    expect(refreshed.eligible).toBe(false);
  });
});
