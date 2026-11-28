/**
 * Shopify customer → marketing subscriber sync (paginated Admin GraphQL).
 * API version: 2026-10 (defaultEmailAddress + emailMarketingConsent).
 * Minimizes stored PII to email + consent + Shopify GID (server-only).
 */
import type { Prisma, Subscriber } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import {
  MarketingConsentState,
  SuppressionReason,
} from "../lib/prisma.server";
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { adminGraphql } from "../shopify/admin-graphql.server";
import {
  applyShopifyConsentChange,
  calculateNextEmailAt,
  hasActiveSuppression,
  isMarketingEligible,
  isValidEmail,
  normalizeEmail,
  parseMarketingConsentState,
  cancelPendingJobsForSubscriber,
} from "./consent.server";

export const CUSTOMER_SYNC_PAGE_SIZE = 50;
export const CUSTOMER_PAGES_PER_TICK = 10;

export type ShopifyCustomerNode = {
  id: string;
  updatedAt: string;
  defaultEmailAddress: {
    emailAddress: string | null;
    marketingState: string | null;
  } | null;
  emailMarketingConsent: {
    marketingState: string;
    consentUpdatedAt: string | null;
  } | null;
};

export type CustomerSyncStats = {
  shopifyCustomerCount: number | null;
  processed: number;
  upserted: number;
  eligible: number;
  skipped: number;
  softDeleted: number;
  redacted: number;
  errors: number;
  partialErrors: string[];
  hasMore: boolean;
  cursor: string | null;
  phase: string;
  seenGids: string[];
};

function emptyStats(
  overrides: Partial<CustomerSyncStats> = {},
): CustomerSyncStats {
  return {
    shopifyCustomerCount: null,
    processed: 0,
    upserted: 0,
    eligible: 0,
    skipped: 0,
    softDeleted: 0,
    redacted: 0,
    errors: 0,
    partialErrors: [],
    hasMore: false,
    cursor: null,
    phase: "idle",
    seenGids: [],
    ...overrides,
  };
}

const CUSTOMER_FIELDS = `
  id
  updatedAt
  defaultEmailAddress {
    emailAddress
    marketingState
  }
  emailMarketingConsent {
    marketingState
    consentUpdatedAt
  }
`;

export async function fetchCustomersCount(
  client: AdminGraphqlClient,
  shop: string,
): Promise<number> {
  const { data } = await adminGraphql<{
    customersCount: { count: number };
  }>(
    client,
    `#graphql
      query SmartMailerCustomersCount {
        customersCount {
          count
        }
      }`,
    { shop },
  );
  return data.customersCount.count;
}

export async function fetchCustomersPage(
  client: AdminGraphqlClient,
  shop: string,
  options: { cursor?: string | null; query?: string | null },
): Promise<{
  customers: ShopifyCustomerNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const { data } = await adminGraphql<{
    customers: {
      nodes: ShopifyCustomerNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(
    client,
    `#graphql
      query SmartMailerCustomersPage($first: Int!, $after: String, $query: String) {
        customers(first: $first, after: $after, query: $query) {
          nodes {
            ${CUSTOMER_FIELDS}
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    {
      shop,
      variables: {
        first: CUSTOMER_SYNC_PAGE_SIZE,
        after: options.cursor ?? null,
        query: options.query ?? null,
      },
    },
  );

  return {
    customers: data.customers.nodes,
    hasNextPage: data.customers.pageInfo.hasNextPage,
    endCursor: data.customers.pageInfo.endCursor,
  };
}

export async function fetchCustomerById(
  client: AdminGraphqlClient,
  shop: string,
  customerGid: string,
): Promise<ShopifyCustomerNode | null> {
  const { data } = await adminGraphql<{
    customer: ShopifyCustomerNode | null;
  }>(
    client,
    `#graphql
      query SmartMailerCustomerById($id: ID!) {
        customer(id: $id) {
          ${CUSTOMER_FIELDS}
        }
      }`,
    { shop, variables: { id: customerGid } },
  );
  return data.customer;
}

export function extractConsentFromShopifyCustomer(node: ShopifyCustomerNode): {
  email: string | null;
  marketingState: MarketingConsentState;
  consentUpdatedAt: Date | null;
} {
  const emailRaw = node.defaultEmailAddress?.emailAddress ?? null;
  const email = emailRaw && isValidEmail(emailRaw) ? normalizeEmail(emailRaw) : null;

  const rawState =
    node.emailMarketingConsent?.marketingState ??
    node.defaultEmailAddress?.marketingState ??
    "NOT_SUBSCRIBED";

  return {
    email,
    marketingState: parseMarketingConsentState(rawState),
    consentUpdatedAt: node.emailMarketingConsent?.consentUpdatedAt
      ? new Date(node.emailMarketingConsent.consentUpdatedAt)
      : null,
  };
}

/**
 * Upsert a subscriber mirror. Dedupes by normalized email within the shop.
 * Does not invent SUBSCRIBED — only stores Shopify-reported state.
 */
export async function upsertSubscriberFromShopify(options: {
  shopId: string;
  node: ShopifyCustomerNode;
  intervalDays: number;
}): Promise<{ subscriber: Subscriber | null; eligible: boolean; skipped: boolean }> {
  const extracted = extractConsentFromShopifyCustomer(options.node);

  // No valid email → not a marketing recipient; soft-skip (may soft-delete prior row).
  if (!extracted.email) {
    const existing = await prisma.subscriber.findUnique({
      where: {
        shopId_shopifyCustomerGid: {
          shopId: options.shopId,
          shopifyCustomerGid: options.node.id,
        },
      },
    });
    if (existing && !existing.deletedAt) {
      await markSubscriberIneligible(existing, MarketingConsentState.INVALID);
    }
    return { subscriber: null, eligible: false, skipped: true };
  }

  const suppressed = await hasActiveSuppression(
    options.shopId,
    extracted.email,
  );

  const eligible = isMarketingEligible({
    email: extracted.email,
    marketingConsentState: extracted.marketingState,
    isSuppressed: suppressed,
  });

  // Email uniqueness: if another customer GID owns this email, keep the
  // Shopify GID that currently maps — prefer updating by customer GID.
  const byEmail = await prisma.subscriber.findUnique({
    where: {
      shopId_emailNormalized: {
        shopId: options.shopId,
        emailNormalized: extracted.email,
      },
    },
  });

  if (
    byEmail &&
    byEmail.shopifyCustomerGid !== options.node.id &&
    !byEmail.deletedAt
  ) {
    // Same normalized email, different customer — fail closed for the duplicate:
    // keep existing row, do not create a second recipient.
    logger.warn("subscriber_email_collision", {
      shopId: options.shopId,
    });
    return { subscriber: byEmail, eligible: false, skipped: true };
  }

  const existing = await prisma.subscriber.findUnique({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: options.shopId,
        shopifyCustomerGid: options.node.id,
      },
    },
  });

  const becameEligible =
    eligible && (!existing || !existing.eligible || existing.deletedAt);

  /**
   * Preserve nextEmailAt on routine syncs.
   * Only assign a first Mon/Thu slot for brand-new mirrors or newly eligible
   * never-sent subscribers. Do NOT recompute when nextEmailAt is null (due now)
   * — that previously stamped a future stagger on every customers/update and
   * blocked Flow xloxi-request processing.
   */
  let nextEmailAt = existing?.nextEmailAt ?? null;
  if (eligible) {
    if (!existing) {
      nextEmailAt = calculateNextEmailAt({
        shopId: options.shopId,
        shopifyCustomerGid: options.node.id,
        intervalDays: options.intervalDays,
        staggerInitial: true,
      });
    } else if (becameEligible && !existing.lastSuccessfulEmailAt) {
      nextEmailAt =
        existing.nextEmailAt ??
        calculateNextEmailAt({
          shopId: options.shopId,
          shopifyCustomerGid: options.node.id,
          intervalDays: options.intervalDays,
          staggerInitial: true,
        });
    } else {
      nextEmailAt = existing.nextEmailAt;
    }
  } else {
    nextEmailAt = null;
  }

  const data = {
    email: extracted.email,
    emailNormalized: extracted.email,
    marketingConsentState: extracted.marketingState,
    consentUpdatedAt: extracted.consentUpdatedAt,
    isSuppressed: suppressed,
    eligible,
    nextEmailAt,
    deletedAt: null as Date | null,
  };

  const subscriber = await prisma.subscriber.upsert({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: options.shopId,
        shopifyCustomerGid: options.node.id,
      },
    },
    create: {
      shopId: options.shopId,
      shopifyCustomerGid: options.node.id,
      currentCycleNumber: 1,
      ...data,
    },
    update: data,
  });

  if (
    existing &&
    existing.marketingConsentState !== extracted.marketingState
  ) {
    await applyShopifyConsentChange({
      shopId: options.shopId,
      subscriberId: subscriber.id,
      emailNormalized: extracted.email,
      marketingState: extracted.marketingState,
      consentUpdatedAt: extracted.consentUpdatedAt,
    });
    // Re-apply eligibility after consent side-effects.
    const againSuppressed = await hasActiveSuppression(
      options.shopId,
      extracted.email,
    );
    const againEligible = isMarketingEligible({
      email: extracted.email,
      marketingConsentState: extracted.marketingState,
      isSuppressed: againSuppressed,
    });
    return {
      subscriber: await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          eligible: againEligible,
          isSuppressed: againSuppressed,
          nextEmailAt: againEligible
            ? subscriber.nextEmailAt ??
              calculateNextEmailAt({
                shopId: options.shopId,
                shopifyCustomerGid: options.node.id,
                intervalDays: options.intervalDays,
                lastSuccessfulEmailAt: subscriber.lastSuccessfulEmailAt,
              })
            : null,
        },
      }),
      eligible: againEligible,
      skipped: false,
    };
  }

  if (!eligible && existing?.eligible) {
    await cancelPendingJobsForSubscriber(
      options.shopId,
      subscriber.id,
      "became_ineligible",
    );
  }

  return { subscriber, eligible, skipped: false };
}

async function markSubscriberIneligible(
  subscriber: Subscriber,
  state: MarketingConsentState,
): Promise<void> {
  await cancelPendingJobsForSubscriber(
    subscriber.shopId,
    subscriber.id,
    `ineligible_${state}`,
  );
  await prisma.subscriber.update({
    where: { id: subscriber.id },
    data: {
      marketingConsentState: state,
      eligible: false,
      nextEmailAt: null,
    },
  });
}

export async function softDeleteSubscriberByGid(
  shopId: string,
  shopifyCustomerGid: string,
): Promise<boolean> {
  const existing = await prisma.subscriber.findUnique({
    where: {
      shopId_shopifyCustomerGid: { shopId, shopifyCustomerGid },
    },
  });
  if (!existing || existing.deletedAt) return false;

  await cancelPendingJobsForSubscriber(shopId, existing.id, "customer_deleted");
  await prisma.subscriber.update({
    where: { id: existing.id },
    data: {
      deletedAt: new Date(),
      eligible: false,
      nextEmailAt: null,
      // Minimize residual PII while keeping referential integrity for history.
      email: "",
      emailNormalized: `deleted:${existing.id}`,
      marketingConsentState: MarketingConsentState.REDACTED,
      isSuppressed: true,
    },
  });
  return true;
}

/**
 * GDPR / privacy redact: wipe personal fields, suppress, cancel jobs.
 */
export async function redactSubscriberPrivacy(options: {
  shopId: string;
  shopifyCustomerGid?: string | null;
  email?: string | null;
}): Promise<number> {
  const where: Prisma.SubscriberWhereInput = {
    shopId: options.shopId,
    deletedAt: null,
    OR: [
      options.shopifyCustomerGid
        ? { shopifyCustomerGid: options.shopifyCustomerGid }
        : undefined,
      options.email
        ? { emailNormalized: normalizeEmail(options.email) }
        : undefined,
    ].filter(Boolean) as Prisma.SubscriberWhereInput[],
  };

  if (!where.OR || (where.OR as unknown[]).length === 0) return 0;

  const rows = await prisma.subscriber.findMany({ where });
  for (const row of rows) {
    await cancelPendingJobsForSubscriber(
      options.shopId,
      row.id,
      "privacy_redact",
    );
    await prisma.suppression.upsert({
      where: {
        shopId_emailNormalized_reason: {
          shopId: options.shopId,
          emailNormalized: row.emailNormalized || `redacted:${row.id}`,
          reason: SuppressionReason.REDACTED,
        },
      },
      create: {
        shopId: options.shopId,
        subscriberId: row.id,
        emailNormalized: row.emailNormalized || `redacted:${row.id}`,
        reason: SuppressionReason.REDACTED,
        source: "privacy",
        active: true,
      },
      update: { active: true, liftedAt: null, subscriberId: row.id },
    });
    await prisma.subscriber.update({
      where: { id: row.id },
      data: {
        email: "",
        emailNormalized: `redacted:${row.id}`,
        marketingConsentState: MarketingConsentState.REDACTED,
        consentUpdatedAt: new Date(),
        eligible: false,
        isSuppressed: true,
        nextEmailAt: null,
        deletedAt: new Date(),
      },
    });
  }
  return rows.length;
}

export async function syncSingleCustomer(
  client: AdminGraphqlClient,
  shopDomain: string,
  shopId: string,
  customerGid: string,
  intervalDays: number,
): Promise<CustomerSyncStats> {
  const stats = emptyStats({ phase: "single" });
  try {
    const node = await fetchCustomerById(client, shopDomain, customerGid);
    if (!node) {
      stats.softDeleted = (await softDeleteSubscriberByGid(shopId, customerGid))
        ? 1
        : 0;
      stats.processed = 1;
      return stats;
    }
    const result = await upsertSubscriberFromShopify({
      shopId,
      node,
      intervalDays,
    });
    stats.processed = 1;
    if (result.skipped) stats.skipped = 1;
    else {
      stats.upserted = 1;
      if (result.eligible) stats.eligible = 1;
    }
  } catch (error) {
    stats.errors += 1;
    stats.partialErrors.push(
      error instanceof Error ? error.message : "single_customer_failed",
    );
  }
  return stats;
}

export async function runCustomerSyncTick(
  client: AdminGraphqlClient,
  options: {
    shopDomain: string;
    shopId: string;
    intervalDays: number;
    cursor?: string | null;
    shopifyQuery?: string | null;
    fullReconcile?: boolean;
    seenGids?: string[];
    pagesPerTick?: number;
  },
): Promise<CustomerSyncStats> {
  const pagesPerTick = options.pagesPerTick ?? CUSTOMER_PAGES_PER_TICK;
  const count = await fetchCustomersCount(client, options.shopDomain);
  const stats = emptyStats({
    shopifyCustomerCount: count,
    phase: "pagination",
    cursor: options.cursor ?? null,
  });

  let cursor = options.cursor ?? null;
  let hasNextPage = true;
  const seenGids = [...(options.seenGids ?? [])];

  for (let page = 0; page < pagesPerTick && hasNextPage; page++) {
    try {
      const result = await fetchCustomersPage(client, options.shopDomain, {
        cursor,
        query: options.shopifyQuery,
      });

      for (const node of result.customers) {
        try {
          const upserted = await upsertSubscriberFromShopify({
            shopId: options.shopId,
            node,
            intervalDays: options.intervalDays,
          });
          stats.processed += 1;
          seenGids.push(node.id);
          if (upserted.skipped) stats.skipped += 1;
          else {
            stats.upserted += 1;
            if (upserted.eligible) stats.eligible += 1;
          }
        } catch (error) {
          stats.errors += 1;
          stats.partialErrors.push(
            error instanceof Error ? error.message : "upsert_failed",
          );
        }
      }

      hasNextPage = result.hasNextPage;
      cursor = result.endCursor;
      stats.cursor = cursor;
      stats.hasMore = hasNextPage;
    } catch (error) {
      stats.errors += 1;
      stats.partialErrors.push(
        error instanceof Error ? error.message : "page_failed",
      );
      stats.hasMore = true;
      stats.phase = "pagination_interrupted";
      stats.seenGids = seenGids;
      return stats;
    }
  }

  if (!stats.hasMore && options.fullReconcile && !options.shopifyQuery) {
    stats.phase = "reconcile_deletes";
    stats.softDeleted = await reconcileDeletedSubscribers(
      options.shopId,
      seenGids,
    );
  }

  stats.phase = stats.hasMore ? "pagination_continue" : "pagination_complete";
  stats.seenGids = seenGids;
  return stats;
}

export async function reconcileDeletedSubscribers(
  shopId: string,
  seenShopifyGids: string[],
): Promise<number> {
  if (seenShopifyGids.length === 0) return 0;

  const stale = await prisma.subscriber.findMany({
    where: {
      shopId,
      deletedAt: null,
      shopifyCustomerGid: { notIn: seenShopifyGids },
    },
    select: { shopifyCustomerGid: true },
  });

  let count = 0;
  for (const row of stale) {
    if (await softDeleteSubscriberByGid(shopId, row.shopifyCustomerGid)) {
      count += 1;
    }
  }
  return count;
}

export type SubscriberListFilter = {
  shopId: string;
  q?: string | null;
  eligible?: boolean | null;
  consent?: MarketingConsentState | null;
  suppressed?: boolean | null;
  page?: number;
  pageSize?: number;
};

export async function listSubscribers(filter: SubscriberListFilter) {
  const page = Math.max(filter.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const where: Prisma.SubscriberWhereInput = {
    shopId: filter.shopId,
    deletedAt: null,
  };

  if (filter.eligible != null) where.eligible = filter.eligible;
  if (filter.suppressed != null) where.isSuppressed = filter.suppressed;
  if (filter.consent) where.marketingConsentState = filter.consent;
  if (filter.q) {
    const q = filter.q.trim().toLowerCase();
    where.OR = [
      { emailNormalized: { contains: q } },
      { shopifyCustomerGid: { contains: q } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.subscriber.count({ where }),
    prisma.subscriber.findMany({
      where,
      orderBy: [{ eligible: "desc" }, { nextEmailAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        shopifyCustomerGid: true,
        email: true,
        emailNormalized: true,
        marketingConsentState: true,
        isSuppressed: true,
        eligible: true,
        currentCycleNumber: true,
        nextEmailAt: true,
        lastSuccessfulEmailAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return { total, page, pageSize, rows };
}

export async function getSubscriberCounts(shopId: string) {
  const [total, eligible, suppressed, subscribed, unsubscribed] =
    await Promise.all([
      prisma.subscriber.count({ where: { shopId, deletedAt: null } }),
      prisma.subscriber.count({
        where: { shopId, deletedAt: null, eligible: true },
      }),
      prisma.subscriber.count({
        where: { shopId, deletedAt: null, isSuppressed: true },
      }),
      prisma.subscriber.count({
        where: {
          shopId,
          deletedAt: null,
          marketingConsentState: MarketingConsentState.SUBSCRIBED,
        },
      }),
      prisma.subscriber.count({
        where: {
          shopId,
          deletedAt: null,
          marketingConsentState: MarketingConsentState.UNSUBSCRIBED,
        },
      }),
    ]);

  return { total, eligible, suppressed, subscribed, unsubscribed };
}
