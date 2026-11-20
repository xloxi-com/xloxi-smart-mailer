/**
 * Inventory-level sync — updates mirrored quantities and recomputes eligibility.
 * Read-only against Shopify (does not mutate inventory).
 */
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  computeProductInStock,
  isProductEligible,
  isVariantSellable,
  normalizeInventoryPolicy,
} from "../domain/product-eligibility.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { adminGraphql } from "../shopify/admin-graphql.server";
import { upsertMirroredProduct } from "./product-sync.server";
import { fetchProductById } from "./shopify-graphql.server";

export type InventoryLevelWebhookPayload = {
  inventory_item_id?: number | string;
  available?: number;
  location_id?: number | string;
  updated_at?: string;
};

/**
 * After an inventory webhook, refresh the linked variant quantity and
 * recompute parent product eligibility. Optionally re-fetch the product
 * from Shopify for full accuracy.
 */
export async function applyInventoryLevelUpdate(options: {
  shopId: string;
  shopDomain: string;
  inventoryItemGidOrLegacyId: string | number;
  available?: number;
  inStockOnly: boolean;
  client?: AdminGraphqlClient;
}): Promise<{ updated: boolean; productGid?: string }> {
  const inventoryItemGid =
    typeof options.inventoryItemGidOrLegacyId === "number" ||
    /^\d+$/.test(String(options.inventoryItemGidOrLegacyId))
      ? `gid://shopify/InventoryItem/${options.inventoryItemGidOrLegacyId}`
      : String(options.inventoryItemGidOrLegacyId);

  const variant = await prisma.productVariant.findFirst({
    where: {
      shopId: options.shopId,
      inventoryItemGid,
      deletedAt: null,
    },
    include: { product: true },
  });

  if (!variant) {
    logger.info("inventory_sync_variant_not_found", {
      shop: options.shopDomain,
      inventoryItemGid,
    });
    return { updated: false };
  }

  // Prefer a full product re-fetch when Admin client is available.
  if (options.client) {
    const node = await fetchProductById(
      options.client,
      options.shopDomain,
      variant.product.shopifyProductGid,
    );
    if (node) {
      await upsertMirroredProduct(
        options.shopId,
        node,
        options.inStockOnly,
      );
      return {
        updated: true,
        productGid: variant.product.shopifyProductGid,
      };
    }
  }

  const nextQty =
    typeof options.available === "number"
      ? options.available
      : variant.inventoryQuantity;

  const sellable = isVariantSellable({
    tracksInventory: variant.tracksInventory,
    inventoryPolicy: normalizeInventoryPolicy(variant.inventoryPolicy),
    inventoryQuantity: nextQty,
    availableForSale: true,
  });

  await prisma.productVariant.update({
    where: { id: variant.id },
    data: {
      inventoryQuantity: nextQty,
      availableForSale: sellable,
      // Clear advertised prices when no longer sellable.
      ...(sellable
        ? {}
        : { price: null, compareAtPrice: null }),
    },
  });

  await recomputeProductAvailability(
    options.shopId,
    variant.productId,
    options.inStockOnly,
  );

  return {
    updated: true,
    productGid: variant.product.shopifyProductGid,
  };
}

export async function recomputeProductAvailability(
  shopId: string,
  productId: string,
  inStockOnly: boolean,
): Promise<void> {
  const product = await prisma.product.findFirst({
    where: { id: productId, shopId },
    include: {
      variants: { where: { deletedAt: null } },
    },
  });
  if (!product || product.deletedAt) return;

  const variantInputs = product.variants.map((v) => ({
    tracksInventory: v.tracksInventory,
    inventoryPolicy: normalizeInventoryPolicy(v.inventoryPolicy),
    inventoryQuantity: v.inventoryQuantity,
    availableForSale: v.availableForSale,
  }));

  const inStock = computeProductInStock(variantInputs);
  const eligible = isProductEligible({
    status: product.status,
    publishedToOnlineStore: product.publishedToOnlineStore,
    inStockOnly,
    variants: variantInputs,
  });

  await prisma.product.update({
    where: { id: product.id },
    data: {
      inStock,
      eligible,
      totalInventory: product.variants.reduce(
        (sum, v) => sum + (v.tracksInventory ? v.inventoryQuantity : 0),
        0,
      ),
      lastSyncedAt: new Date(),
    },
  });
}

/**
 * Optional live inventory item lookup (read-only).
 */
export async function fetchInventoryItemTracked(
  client: AdminGraphqlClient,
  shop: string,
  inventoryItemGid: string,
): Promise<{ id: string; tracked: boolean } | null> {
  const { data } = await adminGraphql<{
    inventoryItem: { id: string; tracked: boolean } | null;
  }>(
    client,
    `#graphql
      query SmartMailerInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          id
          tracked
        }
      }`,
    { shop, variables: { id: inventoryItemGid } },
  );
  return data.inventoryItem;
}
