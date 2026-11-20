import { describe, expect, it } from "vitest";
import {
  advertisableVariantPrices,
  computeProductInStock,
  isProductEligible,
  isVariantSellable,
  minMaxAdvertisablePrices,
} from "./product-eligibility.server";

describe("isVariantSellable", () => {
  it("treats untracked inventory as sellable", () => {
    expect(
      isVariantSellable({
        tracksInventory: false,
        inventoryPolicy: "DENY",
        inventoryQuantity: 0,
        availableForSale: true,
      }),
    ).toBe(true);
  });

  it("allows CONTINUE policy at zero quantity", () => {
    expect(
      isVariantSellable({
        tracksInventory: true,
        inventoryPolicy: "CONTINUE",
        inventoryQuantity: 0,
        availableForSale: true,
      }),
    ).toBe(true);
  });

  it("denies tracked DENY variants at zero quantity", () => {
    expect(
      isVariantSellable({
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 0,
        availableForSale: true,
      }),
    ).toBe(false);
  });

  it("requires availableForSale when false", () => {
    expect(
      isVariantSellable({
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 5,
        availableForSale: false,
      }),
    ).toBe(false);
  });
});

describe("isProductEligible", () => {
  const sellable = {
    tracksInventory: true,
    inventoryPolicy: "DENY",
    inventoryQuantity: 3,
    availableForSale: true,
  };

  it("requires ACTIVE + online published + stock when inStockOnly", () => {
    expect(
      isProductEligible({
        status: "ACTIVE",
        publishedToOnlineStore: true,
        inStockOnly: true,
        variants: [sellable],
      }),
    ).toBe(true);

    expect(
      isProductEligible({
        status: "DRAFT",
        publishedToOnlineStore: true,
        variants: [sellable],
      }),
    ).toBe(false);

    expect(
      isProductEligible({
        status: "ACTIVE",
        publishedToOnlineStore: false,
        variants: [sellable],
      }),
    ).toBe(false);
  });

  it("can skip stock gate when inStockOnly is false", () => {
    expect(
      isProductEligible({
        status: "ACTIVE",
        publishedToOnlineStore: true,
        inStockOnly: false,
        variants: [
          {
            tracksInventory: true,
            inventoryPolicy: "DENY",
            inventoryQuantity: 0,
            availableForSale: false,
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("advertisableVariantPrices", () => {
  it("omits prices for unavailable variants", () => {
    const prices = advertisableVariantPrices([
      {
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 0,
        availableForSale: false,
        price: "10.00",
        compareAtPrice: "12.00",
      },
      {
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 2,
        availableForSale: true,
        price: "20.00",
        compareAtPrice: null,
      },
    ]);

    expect(prices).toEqual([{ price: "20.00", compareAtPrice: null }]);
    expect(minMaxAdvertisablePrices(prices)).toEqual({
      min: "20",
      max: "20",
    });
    expect(computeProductInStock([
      {
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 0,
        availableForSale: false,
      },
      {
        tracksInventory: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 2,
        availableForSale: true,
      },
    ])).toBe(true);
  });
});
