/**
 * Read-only Shopify Admin GraphQL helpers for catalog sync.
 * Never mutates products, prices, inventory, or storefront content.
 */
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { adminGraphql } from "../shopify/admin-graphql.server";

export const PRODUCT_SYNC_PAGE_SIZE = 25;
/** Catalogs at or above this size use Bulk Operations instead of deep pagination. */
export const BULK_SYNC_THRESHOLD = 500;
/**
 * Max GraphQL pages per Sync Now / job tick (resumable via cursor).
 * Batched DB writes keep 1–2 pages safe under embedded-admin timeouts.
 */
export const PAGES_PER_TICK = 2;
/** Soft wall-clock budget per tick; leave early with hasMore when exceeded. */
export const PRODUCT_SYNC_TICK_BUDGET_MS = 12_000;
/** Max time one Sync products POST may spend running ticks server-side. */
export const PRODUCT_SYNC_REQUEST_BUDGET_MS = 10_000;

export type ShopifyMoney = {
  amount: string;
  currencyCode: string;
};

export type ShopifyVariantNode = {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE" | string;
  availableForSale: boolean;
  updatedAt: string;
  inventoryItem: {
    id: string;
    tracked: boolean;
  } | null;
};

export type ShopifyProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  tracksInventory: boolean;
  onlineStoreUrl: string | null;
  /** Set when published to Online Store (works even if storefront password hides URL). */
  publishedAt: string | null;
  updatedAt: string;
  featuredImage: { url: string } | null;
  priceRangeV2: {
    minVariantPrice: ShopifyMoney;
    maxVariantPrice: ShopifyMoney;
  } | null;
  variants: {
    nodes: ShopifyVariantNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  totalInventory
  tracksInventory
  onlineStoreUrl
  publishedAt
  updatedAt
  featuredImage { url }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  variants(first: 50) {
    nodes {
      id
      title
      sku
      barcode
      price
      compareAtPrice
      inventoryQuantity
      inventoryPolicy
      availableForSale
      updatedAt
      inventoryItem { id tracked }
    }
    pageInfo { hasNextPage endCursor }
  }
`;

export async function fetchProductsCount(
  client: AdminGraphqlClient,
  shop: string,
): Promise<number> {
  const { data } = await adminGraphql<{
    productsCount: { count: number };
  }>(
    client,
    `#graphql
      query SmartMailerProductsCount {
        productsCount {
          count
        }
      }`,
    { shop },
  );
  return data.productsCount.count;
}

export async function fetchProductsPage(
  client: AdminGraphqlClient,
  shop: string,
  options: { cursor?: string | null; query?: string },
): Promise<{
  products: ShopifyProductNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const { data } = await adminGraphql<{
    products: {
      nodes: ShopifyProductNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(
    client,
    `#graphql
      query SmartMailerProductsPage($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query) {
          nodes {
            ${PRODUCT_FIELDS}
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    {
      shop,
      variables: {
        first: PRODUCT_SYNC_PAGE_SIZE,
        after: options.cursor ?? null,
        query: options.query ?? null,
      },
    },
  );

  return {
    products: data.products.nodes,
    hasNextPage: data.products.pageInfo.hasNextPage,
    endCursor: data.products.pageInfo.endCursor,
  };
}

export async function fetchProductById(
  client: AdminGraphqlClient,
  shop: string,
  productGid: string,
): Promise<ShopifyProductNode | null> {
  const { data } = await adminGraphql<{
    product: ShopifyProductNode | null;
  }>(
    client,
    `#graphql
      query SmartMailerProductById($id: ID!) {
        product(id: $id) {
          ${PRODUCT_FIELDS}
        }
      }`,
    { shop, variables: { id: productGid } },
  );
  return data.product;
}

export async function startProductsBulkQuery(
  client: AdminGraphqlClient,
  shop: string,
): Promise<{ bulkOperationId: string | null; userErrors: string[] }> {
  const bulkQuery = `{
    products {
      edges {
        node {
          id
          title
          handle
          status
          totalInventory
          tracksInventory
          onlineStoreUrl
          publishedAt
          updatedAt
          featuredImage { url }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                availableForSale
                updatedAt
                inventoryItem { id tracked }
              }
            }
          }
        }
      }
    }
  }`;

  const { data } = await adminGraphql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { message: string }[];
    };
  }>(
    client,
    `#graphql
      mutation SmartMailerBulkProducts($query: String!) {
        bulkOperationRunQuery(query: $query) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }`,
    { shop, variables: { query: bulkQuery } },
  );

  return {
    bulkOperationId: data.bulkOperationRunQuery.bulkOperation?.id ?? null,
    userErrors: data.bulkOperationRunQuery.userErrors.map((e) => e.message),
  };
}

export async function fetchBulkOperation(
  client: AdminGraphqlClient,
  shop: string,
  id: string,
): Promise<{
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
}> {
  const { data } = await adminGraphql<{
    bulkOperation: {
      id: string;
      status: string;
      errorCode: string | null;
      objectCount: string | null;
      url: string | null;
    } | null;
  }>(
    client,
    `#graphql
      query SmartMailerBulkOperation($id: ID!) {
        bulkOperation(id: $id) {
          id
          status
          errorCode
          objectCount
          url
        }
      }`,
    { shop, variables: { id } },
  );

  if (!data.bulkOperation) {
    throw new Error(`Bulk operation not found: ${id}`);
  }
  return data.bulkOperation;
}

/**
 * Parse Shopify bulk JSONL where nested variants appear as separate lines
 * with `__parentId` pointing at the product GID.
 */
export function parseBulkProductsJsonl(jsonl: string): ShopifyProductNode[] {
  const products = new Map<string, ShopifyProductNode>();
  const variantsByParent = new Map<string, ShopifyVariantNode[]>();

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const id = String(row.id ?? "");
    const parentId =
      typeof row.__parentId === "string" ? row.__parentId : null;

    if (id.includes("/Product/") && !parentId) {
      products.set(id, {
        id,
        title: String(row.title ?? ""),
        handle: String(row.handle ?? ""),
        status: String(row.status ?? "ACTIVE"),
        totalInventory: Number(row.totalInventory ?? 0),
        tracksInventory: Boolean(row.tracksInventory),
        onlineStoreUrl:
          typeof row.onlineStoreUrl === "string" ? row.onlineStoreUrl : null,
        publishedAt:
          typeof row.publishedAt === "string" ? row.publishedAt : null,
        updatedAt: String(row.updatedAt ?? new Date().toISOString()),
        featuredImage:
          row.featuredImage && typeof row.featuredImage === "object"
            ? { url: String((row.featuredImage as { url?: string }).url ?? "") }
            : null,
        priceRangeV2:
          row.priceRangeV2 && typeof row.priceRangeV2 === "object"
            ? (row.priceRangeV2 as ShopifyProductNode["priceRangeV2"])
            : null,
        variants: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    } else if (id.includes("/ProductVariant/") && parentId) {
      const list = variantsByParent.get(parentId) ?? [];
      const inventoryItem =
        row.inventoryItem && typeof row.inventoryItem === "object"
          ? (row.inventoryItem as { id: string; tracked: boolean })
          : null;
      list.push({
        id,
        title: typeof row.title === "string" ? row.title : null,
        sku: typeof row.sku === "string" ? row.sku : null,
        barcode: typeof row.barcode === "string" ? row.barcode : null,
        price: String(row.price ?? "0"),
        compareAtPrice:
          typeof row.compareAtPrice === "string" ? row.compareAtPrice : null,
        inventoryQuantity:
          typeof row.inventoryQuantity === "number"
            ? row.inventoryQuantity
            : null,
        inventoryPolicy: String(row.inventoryPolicy ?? "DENY"),
        availableForSale: Boolean(row.availableForSale),
        updatedAt: String(row.updatedAt ?? new Date().toISOString()),
        inventoryItem,
      });
      variantsByParent.set(parentId, list);
    }
  }

  for (const [productId, product] of products) {
    product.variants.nodes = variantsByParent.get(productId) ?? [];
  }

  return [...products.values()];
}
