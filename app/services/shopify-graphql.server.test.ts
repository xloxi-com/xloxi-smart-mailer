import { describe, expect, it } from "vitest";
import { parseBulkProductsJsonl } from "./shopify-graphql.server";

describe("parseBulkProductsJsonl", () => {
  it("rehydrates products and nested variants via __parentId", () => {
    const jsonl = [
      JSON.stringify({
        id: "gid://shopify/Product/1",
        title: "Board",
        handle: "board",
        status: "ACTIVE",
        totalInventory: 2,
        tracksInventory: true,
        onlineStoreUrl: "https://example.com/products/board",
        updatedAt: "2026-01-01T00:00:00Z",
        featuredImage: { url: "https://cdn/img.png" },
        priceRangeV2: {
          minVariantPrice: { amount: "10.0", currencyCode: "USD" },
          maxVariantPrice: { amount: "10.0", currencyCode: "USD" },
        },
      }),
      JSON.stringify({
        id: "gid://shopify/ProductVariant/11",
        __parentId: "gid://shopify/Product/1",
        title: "Default",
        sku: "SKU-1",
        barcode: null,
        price: "10.0",
        compareAtPrice: null,
        inventoryQuantity: 2,
        inventoryPolicy: "DENY",
        availableForSale: true,
        updatedAt: "2026-01-01T00:00:00Z",
        inventoryItem: { id: "gid://shopify/InventoryItem/99", tracked: true },
      }),
    ].join("\n");

    const products = parseBulkProductsJsonl(jsonl);
    expect(products).toHaveLength(1);
    expect(products[0]!.title).toBe("Board");
    expect(products[0]!.variants.nodes).toHaveLength(1);
    expect(products[0]!.variants.nodes[0]!.inventoryItem?.id).toContain(
      "InventoryItem",
    );
  });
});
