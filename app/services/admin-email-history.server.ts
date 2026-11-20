import type { EmailJobStatus, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { maskEmail } from "./consent.server";

export type EmailHistoryFilter = {
  shopId: string;
  q?: string | null;
  status?: EmailJobStatus | null;
  page?: number;
  pageSize?: number;
};

export async function listEmailHistory(filter: EmailHistoryFilter) {
  const page = Math.max(filter.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const where: Prisma.EmailJobWhereInput = { shopId: filter.shopId };

  if (filter.status) where.status = filter.status;
  if (filter.q) {
    const q = filter.q.trim().toLowerCase();
    where.OR = [
      { providerMessageId: { contains: q } },
      { id: { contains: q } },
      { subscriber: { emailNormalized: { contains: q } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.emailJob.count({ where }),
    prisma.emailJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        attemptCount: true,
        maxAttempts: true,
        nextRetryAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        providerMessageId: true,
        providerName: true,
        dryRun: true,
        cycleNumber: true,
        productSnapshot: true,
        subscriber: {
          select: {
            id: true,
            emailNormalized: true,
          },
        },
        products: {
          select: {
            title: true,
            position: true,
            imageUrl: true,
            price: true,
            currencyCode: true,
          },
          orderBy: { position: "asc" },
        },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      providerMessageId: row.providerMessageId,
      providerName: row.providerName,
      dryRun: row.dryRun,
      cycleNumber: row.cycleNumber,
      recipientMasked: maskEmail(row.subscriber.emailNormalized),
      subscriberId: row.subscriber.id,
      products: row.products.map((p) => ({
        title: p.title,
        imageUrl: p.imageUrl,
        price: p.price?.toString() ?? null,
        currencyCode: p.currencyCode,
      })),
    })),
  };
}

export async function getEmailJobPreview(shopId: string, jobId: string) {
  const job = await prisma.emailJob.findFirst({
    where: { shopId, id: jobId },
    select: {
      id: true,
      status: true,
      productSnapshot: true,
      dryRun: true,
      providerMessageId: true,
      createdAt: true,
      products: {
        orderBy: { position: "asc" },
        select: {
          title: true,
          handle: true,
          imageUrl: true,
          price: true,
          currencyCode: true,
          productUrl: true,
        },
      },
      subscriber: { select: { emailNormalized: true } },
    },
  });
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    dryRun: job.dryRun,
    providerMessageId: job.providerMessageId,
    createdAt: job.createdAt.toISOString(),
    recipientMasked: maskEmail(job.subscriber.emailNormalized),
    products: job.products.map((p) => ({
      title: p.title,
      handle: p.handle,
      imageUrl: p.imageUrl,
      price: p.price?.toString() ?? null,
      currencyCode: p.currencyCode,
      productUrl: p.productUrl,
    })),
    snapshot: job.productSnapshot,
  };
}
