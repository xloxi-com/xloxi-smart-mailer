import type { MarketingConsentState, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { maskEmail } from "./consent.server";

export type AdminSubscriberFilter = {
  shopId: string;
  q?: string | null;
  eligible?: boolean | null;
  consent?: MarketingConsentState | null;
  suppressed?: boolean | null;
  paused?: boolean | null;
  page?: number;
  pageSize?: number;
};

export async function listAdminSubscribers(filter: AdminSubscriberFilter) {
  const page = Math.max(filter.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const where: Prisma.SubscriberWhereInput = {
    shopId: filter.shopId,
    deletedAt: null,
  };

  if (filter.eligible != null) where.eligible = filter.eligible;
  if (filter.suppressed != null) where.isSuppressed = filter.suppressed;
  if (filter.paused != null) where.paused = filter.paused;
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
        emailNormalized: true,
        marketingConsentState: true,
        isSuppressed: true,
        eligible: true,
        paused: true,
        currentCycleNumber: true,
        nextEmailAt: true,
        lastSuccessfulEmailAt: true,
        lastProcessedAt: true,
        updatedAt: true,
        _count: {
          select: {
            productHistory: true,
          },
        },
      },
    }),
  ]);

  const cycleCounts = await Promise.all(
    rows.map((row) =>
      prisma.productHistory.count({
        where: {
          shopId: filter.shopId,
          subscriberId: row.id,
          cycleNumber: row.currentCycleNumber,
        },
      }),
    ),
  );

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row, i) => ({
      id: row.id,
      shopifyCustomerGid: row.shopifyCustomerGid,
      emailMasked: maskEmail(row.emailNormalized),
      marketingConsentState: row.marketingConsentState,
      isSuppressed: row.isSuppressed,
      eligible: row.eligible,
      paused: row.paused,
      currentCycleNumber: row.currentCycleNumber,
      productsSentInCycle: cycleCounts[i] ?? 0,
      productsSentTotal: row._count.productHistory,
      nextEmailAt: row.nextEmailAt?.toISOString() ?? null,
      lastSuccessfulEmailAt: row.lastSuccessfulEmailAt?.toISOString() ?? null,
      lastProcessedAt: row.lastProcessedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function setSubscriberPaused(
  shopId: string,
  subscriberId: string,
  paused: boolean,
): Promise<boolean> {
  const result = await prisma.subscriber.updateMany({
    where: { shopId, id: subscriberId, deletedAt: null },
    data: { paused },
  });
  return result.count > 0;
}

export async function getSubscriberProductHistory(
  shopId: string,
  subscriberId: string,
  page = 1,
  pageSize = 50,
) {
  const safePage = Math.max(page, 1);
  const safeSize = Math.min(Math.max(pageSize, 1), 100);
  const where = { shopId, subscriberId };

  const [total, rows, subscriber] = await Promise.all([
    prisma.productHistory.count({ where }),
    prisma.productHistory.findMany({
      where,
      orderBy: [{ cycleNumber: "desc" }, { sentAt: "desc" }],
      skip: (safePage - 1) * safeSize,
      take: safeSize,
      select: {
        id: true,
        cycleNumber: true,
        sentAt: true,
        product: {
          select: {
            id: true,
            title: true,
            imageUrl: true,
            handle: true,
          },
        },
      },
    }),
    prisma.subscriber.findFirst({
      where: { shopId, id: subscriberId },
      select: {
        id: true,
        emailNormalized: true,
        currentCycleNumber: true,
        paused: true,
        eligible: true,
      },
    }),
  ]);

  if (!subscriber) return null;

  return {
    subscriber: {
      id: subscriber.id,
      emailMasked: maskEmail(subscriber.emailNormalized),
      currentCycleNumber: subscriber.currentCycleNumber,
      paused: subscriber.paused,
      eligible: subscriber.eligible,
    },
    total,
    page: safePage,
    pageSize: safeSize,
    rows: rows.map((r) => ({
      id: r.id,
      cycleNumber: r.cycleNumber,
      sentAt: r.sentAt.toISOString(),
      product: r.product,
    })),
  };
}
