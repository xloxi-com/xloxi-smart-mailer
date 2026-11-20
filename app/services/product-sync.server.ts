/**
 * Product catalog mirror sync (read-only against Shopify).
 */
import { Prisma } from "../lib/prisma.server";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { toMerchantSafeError } from "../lib/safe-error.server";
import {
  advertisableVariantPrices,
  computeProductInStock,
  isProductEligible,
  isVariantSellable,
  minMaxAdvertisablePrices,
  normalizeInventoryPolicy,
  type VariantStockInput,
} from "../domain/product-eligibility.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import {
  BULK_SYNC_THRESHOLD,
  PAGES_PER_TICK,
  fetchBulkOperation,
  fetchProductById,
  fetchProductsCount,
  fetchProductsPage,
  parseBulkProductsJsonl,
  startProductsBulkQuery,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from "./shopify-graphql.server";

export type ProductSyncStats = {
  mode: "pagination" | "bulk" | "single" | "reconcile";
  shopifyProductCount: number | null;
  processed: number;
  upserted: number;
  softDeleted: number;
  eligible: number;
  errors: number;
  partialErrors: string[];
  hasMore: boolean;
  cursor: string | null;
  bulkOperationId: string | null;
  bulkStatus: string | null;
  phase: string;
  /** Accumulated product GIDs for full-reconcile deletes across ticks. */
  seenGids: string[];
};

function emptyStats(
  overrides: Partial<ProductSyncStats> = {},
): ProductSyncStats {
  return {
    mode: "pagination",
    shopifyProductCount: null,
    processed: 0,
    upserted: 0,
    softDeleted: 0,
    eligible: 0,
    errors: 0,
    partialErrors: [],
    hasMore: false,
    cursor: null,
    bulkOperationId: null,
    bulkStatus: null,
    phase: "idle",
    seenGids: [],
    ...overrides,
  };
}

function mapVariantStock(v: ShopifyVariantNode): VariantStockInput {
  return {
    tracksInventory: v.inventoryItem?.tracked ?? true,
    inventoryPolicy: normalizeInventoryPolicy(v.inventoryPolicy),
    inventoryQuantity: v.inventoryQuantity ?? 0,
    availableForSale: v.availableForSale,
  };
}

export function mapShopifyProductToMirror(
  node: ShopifyProductNode,
  inStockOnly: boolean,
) {
  const publishedToOnlineStore = Boolean(node.onlineStoreUrl);
  const variantInputs = node.variants.nodes.map(mapVariantStock);
  const inStock = computeProductInStock(variantInputs);
  const eligible = isProductEligible({
    status: node.status,
    publishedToOnlineStore,
    inStockOnly,
    variants: variantInputs,
  });

  // Never derive advertised min/max from unavailable variants.
  const advertPrices = advertisableVariantPrices(
    node.variants.nodes.map((v) => ({
      ...mapVariantStock(v),
      price: isVariantSellable(mapVariantStock(v)) ? v.price : null,
      compareAtPrice: isVariantSellable(mapVariantStock(v))
        ? v.compareAtPrice
        : null,
    })),
  );
  const { min, max } = minMaxAdvertisablePrices(advertPrices);

  return {
    shopifyProductGid: node.id,
    handle: node.handle,
    title: node.title,
    status: node.status,
    publishedToOnlineStore,
    storefrontUrl: node.onlineStoreUrl,
    totalInventory: node.totalInventory,
    tracksInventory: node.tracksInventory,
    inStock,
    eligible,
    imageUrl: node.featuredImage?.url ?? null,
    priceMin: min != null ? new Prisma.Decimal(min) : null,
    priceMax: max != null ? new Prisma.Decimal(max) : null,
    currencyCode:
      node.priceRangeV2?.minVariantPrice.currencyCode ?? null,
    shopifyUpdatedAt: new Date(node.updatedAt),
    lastSyncedAt: new Date(),
    deletedAt: null as Date | null,
    variants: node.variants.nodes,
  };
}

export async function upsertMirroredProduct(
  shopId: string,
  node: ShopifyProductNode,
  inStockOnly: boolean,
): Promise<{ eligible: boolean }> {
  const mapped = mapShopifyProductToMirror(node, inStockOnly);

  const product = await prisma.product.upsert({
    where: {
      shopId_shopifyProductGid: {
        shopId,
        shopifyProductGid: mapped.shopifyProductGid,
      },
    },
    create: {
      shopId,
      shopifyProductGid: mapped.shopifyProductGid,
      handle: mapped.handle,
      title: mapped.title,
      status: mapped.status,
      publishedToOnlineStore: mapped.publishedToOnlineStore,
      storefrontUrl: mapped.storefrontUrl,
      totalInventory: mapped.totalInventory,
      tracksInventory: mapped.tracksInventory,
      inStock: mapped.inStock,
      eligible: mapped.eligible,
      imageUrl: mapped.imageUrl,
      priceMin: mapped.priceMin,
      priceMax: mapped.priceMax,
      currencyCode: mapped.currencyCode,
      shopifyUpdatedAt: mapped.shopifyUpdatedAt,
      lastSyncedAt: mapped.lastSyncedAt,
      deletedAt: null,
    },
    update: {
      handle: mapped.handle,
      title: mapped.title,
      status: mapped.status,
      publishedToOnlineStore: mapped.publishedToOnlineStore,
      storefrontUrl: mapped.storefrontUrl,
      totalInventory: mapped.totalInventory,
      tracksInventory: mapped.tracksInventory,
      inStock: mapped.inStock,
      eligible: mapped.eligible,
      imageUrl: mapped.imageUrl,
      priceMin: mapped.priceMin,
      priceMax: mapped.priceMax,
      currencyCode: mapped.currencyCode,
      shopifyUpdatedAt: mapped.shopifyUpdatedAt,
      lastSyncedAt: mapped.lastSyncedAt,
      deletedAt: null,
    },
  });

  const seenVariantGids = new Set<string>();

  for (const v of mapped.variants) {
    seenVariantGids.add(v.id);
    const tracks = v.inventoryItem?.tracked ?? true;
    const policy = normalizeInventoryPolicy(v.inventoryPolicy);
    const qty = v.inventoryQuantity ?? 0;
    const sellable = isVariantSellable({
      tracksInventory: tracks,
      inventoryPolicy: policy,
      inventoryQuantity: qty,
      availableForSale: v.availableForSale,
    });

    await prisma.productVariant.upsert({
      where: {
        shopId_shopifyVariantGid: {
          shopId,
          shopifyVariantGid: v.id,
        },
      },
      create: {
        shopId,
        productId: product.id,
        shopifyVariantGid: v.id,
        title: v.title,
        sku: v.sku,
        barcode: v.barcode,
        // Persist Shopify prices for sellable variants; null out advertised
        // prices when not sellable so we never surface unavailable prices.
        price: sellable ? new Prisma.Decimal(v.price) : null,
        compareAtPrice:
          sellable && v.compareAtPrice
            ? new Prisma.Decimal(v.compareAtPrice)
            : null,
        inventoryQuantity: qty,
        inventoryItemGid: v.inventoryItem?.id ?? null,
        tracksInventory: tracks,
        inventoryPolicy: policy,
        availableForSale: sellable,
        shopifyUpdatedAt: new Date(v.updatedAt),
        deletedAt: null,
      },
      update: {
        productId: product.id,
        title: v.title,
        sku: v.sku,
        barcode: v.barcode,
        price: sellable ? new Prisma.Decimal(v.price) : null,
        compareAtPrice:
          sellable && v.compareAtPrice
            ? new Prisma.Decimal(v.compareAtPrice)
            : null,
        inventoryQuantity: qty,
        inventoryItemGid: v.inventoryItem?.id ?? null,
        tracksInventory: tracks,
        inventoryPolicy: policy,
        availableForSale: sellable,
        shopifyUpdatedAt: new Date(v.updatedAt),
        deletedAt: null,
      },
    });
  }

  // Soft-delete variants no longer returned (keep history via product FK).
  await prisma.productVariant.updateMany({
    where: {
      shopId,
      productId: product.id,
      deletedAt: null,
      shopifyVariantGid: { notIn: [...seenVariantGids] },
    },
    data: {
      deletedAt: new Date(),
      availableForSale: false,
      price: null,
      compareAtPrice: null,
    },
  });

  return { eligible: mapped.eligible };
}

/**
 * Soft-delete a product: mark unavailable/ineligible without removing rows
 * (ProductHistory and EmailJobProduct remain intact).
 */
export async function softDeleteProductByGid(
  shopId: string,
  shopifyProductGid: string,
): Promise<boolean> {
  const existing = await prisma.product.findUnique({
    where: {
      shopId_shopifyProductGid: { shopId, shopifyProductGid },
    },
  });
  if (!existing || existing.deletedAt) return false;

  await prisma.$transaction([
    prisma.product.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        eligible: false,
        inStock: false,
        publishedToOnlineStore: false,
        storefrontUrl: null,
      },
    }),
    prisma.productVariant.updateMany({
      where: { productId: existing.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        availableForSale: false,
        price: null,
        compareAtPrice: null,
      },
    }),
  ]);

  return true;
}

export async function syncSingleProduct(
  client: AdminGraphqlClient,
  shopDomain: string,
  shopId: string,
  productGid: string,
  inStockOnly: boolean,
): Promise<ProductSyncStats> {
  const stats = emptyStats({ mode: "single", phase: "single_product" });
  try {
    const node = await fetchProductById(client, shopDomain, productGid);
    if (!node) {
      const removed = await softDeleteProductByGid(shopId, productGid);
      stats.softDeleted = removed ? 1 : 0;
      stats.processed = 1;
      return stats;
    }
    const result = await upsertMirroredProduct(shopId, node, inStockOnly);
    stats.processed = 1;
    stats.upserted = 1;
    stats.eligible = result.eligible ? 1 : 0;
  } catch (error) {
    stats.errors += 1;
    stats.partialErrors.push(
      toMerchantSafeError(error, "single_sync_failed"),
    );
    logger.error("product_sync_single_failed", {
      shop: shopDomain,
      productGid,
    });
  }
  return stats;
}

export type RunProductSyncOptions = {
  shopDomain: string;
  shopId: string;
  inStockOnly: boolean;
  /** Resume pagination cursor or bulk op id carrier. */
  cursor?: string | null;
  bulkOperationId?: string | null;
  /** When true, after import soft-delete local products missing from Shopify. */
  fullReconcile?: boolean;
  /** Optional Shopify search query for incremental sync (e.g. updated_at:>...). */
  shopifyQuery?: string | null;
  pagesPerTick?: number;
  /** Force cursor pagination even for large catalogs (bulk fallback). */
  forcePagination?: boolean;
  /** Accumulated Shopify product GIDs seen across ticks (full reconcile). */
  seenGids?: string[];
};

/**
 * Import / reconcile products. Resumable: returns hasMore + cursor / bulk id.
 */
export async function runProductSyncTick(
  client: AdminGraphqlClient,
  options: RunProductSyncOptions,
): Promise<ProductSyncStats> {
  const pagesPerTick = options.pagesPerTick ?? PAGES_PER_TICK;
  const count = await fetchProductsCount(client, options.shopDomain);

  // Resume or start bulk path for large catalogs.
  if (
    !options.forcePagination &&
    (options.bulkOperationId || count >= BULK_SYNC_THRESHOLD)
  ) {
    return runBulkProductSyncTick(client, options, count);
  }

  const stats = emptyStats({
    mode: "pagination",
    shopifyProductCount: count,
    phase: "pagination",
    cursor: options.cursor ?? null,
  });

  let cursor = options.cursor ?? null;
  let hasNextPage = true;
  const seenGids = [...(options.seenGids ?? [])];

  for (let page = 0; page < pagesPerTick && hasNextPage; page++) {
    try {
      const result = await fetchProductsPage(client, options.shopDomain, {
        cursor,
        query: options.shopifyQuery ?? undefined,
      });

      for (const node of result.products) {
        try {
          const upserted = await upsertMirroredProduct(
            options.shopId,
            node,
            options.inStockOnly,
          );
          stats.processed += 1;
          stats.upserted += 1;
          if (upserted.eligible) stats.eligible += 1;
          seenGids.push(node.id);
        } catch (error) {
          stats.errors += 1;
          stats.partialErrors.push(
            toMerchantSafeError(error, "upsert_failed"),
          );
        }
      }

      hasNextPage = result.hasNextPage;
      cursor = result.endCursor;
      stats.cursor = cursor;
      stats.hasMore = hasNextPage;
    } catch (error) {
      stats.errors += 1;
      stats.partialErrors.push(toMerchantSafeError(error, "page_failed"));
      stats.hasMore = true;
      stats.phase = "pagination_interrupted";
      stats.seenGids = seenGids;
      return stats;
    }
  }

  if (!stats.hasMore && options.fullReconcile && !options.shopifyQuery) {
    stats.phase = "reconcile_deletes";
    stats.softDeleted = await reconcileDeletedProducts(options.shopId, seenGids);
  }

  stats.phase = stats.hasMore ? "pagination_continue" : "pagination_complete";
  stats.seenGids = seenGids;
  return stats;
}

/**
 * After a completed full pagination sync across ticks, soft-delete locals
 * whose GIDs were not observed. Pass the union of seen GIDs from job stats.
 */
export async function reconcileDeletedProducts(
  shopId: string,
  seenShopifyGids: string[],
): Promise<number> {
  if (seenShopifyGids.length === 0) {
    // Safety: never wipe catalog if we somehow saw nothing.
    return 0;
  }

  const result = await prisma.product.updateMany({
    where: {
      shopId,
      deletedAt: null,
      shopifyProductGid: { notIn: seenShopifyGids },
    },
    data: {
      deletedAt: new Date(),
      eligible: false,
      inStock: false,
      publishedToOnlineStore: false,
      storefrontUrl: null,
    },
  });

  await prisma.productVariant.updateMany({
    where: {
      shopId,
      deletedAt: null,
      product: { shopifyProductGid: { notIn: seenShopifyGids } },
    },
    data: {
      deletedAt: new Date(),
      availableForSale: false,
      price: null,
      compareAtPrice: null,
    },
  });

  return result.count;
}

async function runBulkProductSyncTick(
  client: AdminGraphqlClient,
  options: RunProductSyncOptions,
  count: number,
): Promise<ProductSyncStats> {
  const stats = emptyStats({
    mode: "bulk",
    shopifyProductCount: count,
    phase: "bulk",
    bulkOperationId: options.bulkOperationId ?? null,
  });

  let bulkId = options.bulkOperationId ?? null;

  if (!bulkId) {
    const started = await startProductsBulkQuery(client, options.shopDomain);
    if (!started.bulkOperationId) {
      stats.errors += 1;
      stats.partialErrors.push(...started.userErrors);
      // Fallback to pagination if bulk cannot start.
      return runProductSyncTick(client, {
        ...options,
        bulkOperationId: null,
        forcePagination: true,
        pagesPerTick: options.pagesPerTick,
      });
    }
    bulkId = started.bulkOperationId;
    stats.bulkOperationId = bulkId;
    stats.bulkStatus = "CREATED";
    stats.hasMore = true;
    stats.phase = "bulk_started";
    return stats;
  }

  const op = await fetchBulkOperation(client, options.shopDomain, bulkId);
  stats.bulkOperationId = op.id;
  stats.bulkStatus = op.status;

  if (op.status === "RUNNING" || op.status === "CREATED") {
    stats.hasMore = true;
    stats.phase = "bulk_polling";
    return stats;
  }

  if (op.status === "CANCELED" || op.status === "FAILED" || op.status === "EXPIRED") {
    stats.errors += 1;
    stats.partialErrors.push(
      `bulk_${op.status.toLowerCase()}${op.errorCode ? `:${op.errorCode}` : ""}`,
    );
    stats.hasMore = false;
    stats.phase = "bulk_failed";
    return stats;
  }

  if (op.status === "COMPLETED" && op.url) {
    stats.phase = "bulk_importing";
    const response = await fetch(op.url);
    if (!response.ok) {
      stats.errors += 1;
      stats.partialErrors.push(`bulk_download_http_${response.status}`);
      stats.hasMore = true;
      stats.phase = "bulk_download_interrupted";
      return stats;
    }
    const jsonl = await response.text();
    const products = parseBulkProductsJsonl(jsonl);
    const seen: string[] = [];

    for (const node of products) {
      try {
        const result = await upsertMirroredProduct(
          options.shopId,
          node,
          options.inStockOnly,
        );
        stats.processed += 1;
        stats.upserted += 1;
        if (result.eligible) stats.eligible += 1;
        seen.push(node.id);
      } catch (error) {
        stats.errors += 1;
        stats.partialErrors.push(
          toMerchantSafeError(error, "bulk_upsert_failed"),
        );
      }
    }

    if (options.fullReconcile) {
      stats.softDeleted = await reconcileDeletedProducts(options.shopId, seen);
    }

    stats.hasMore = false;
    stats.phase = "bulk_complete";
    stats.bulkOperationId = null;
    return stats;
  }

  stats.hasMore = false;
  stats.phase = "bulk_unknown";
  return stats;
}

export async function getCatalogSyncProgress(shopId: string) {
  const [total, eligible, deleted, latestJob] = await Promise.all([
    prisma.product.count({ where: { shopId, deletedAt: null } }),
    prisma.product.count({ where: { shopId, deletedAt: null, eligible: true } }),
    prisma.product.count({ where: { shopId, deletedAt: { not: null } } }),
    prisma.syncJob.findFirst({
      where: { shopId, type: { in: ["PRODUCTS", "FULL"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    mirroredProducts: total,
    eligibleProducts: eligible,
    softDeletedProducts: deleted,
    latestJob,
  };
}
