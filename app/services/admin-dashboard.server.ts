import {
  EmailEventType,
  EmailJobStatus,
  MarketingConsentState,
  SyncJobStatus,
  SyncJobType,
} from "../lib/prisma.server";
import prisma from "../db.server";
import { ratePct } from "../utils/admin-format";

export async function getDashboardStats(shopId: string) {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalProducts,
    eligibleProducts,
    excludedProducts,
    totalSubscribers,
    activeAutomationSubscribers,
    emailsSent,
    emailsDelivered,
    emailsFailed,
    pendingJobs,
    shop,
    latestProductSync,
    latestCustomerSync,
    recentJobs,
    recentEvents,
    deliveryByDay,
  ] = await Promise.all([
    prisma.product.count({ where: { shopId, deletedAt: null } }),
    prisma.product.count({
      where: {
        shopId,
        deletedAt: null,
        eligible: true,
        excludedFromAutomation: false,
      },
    }),
    prisma.product.count({
      where: { shopId, deletedAt: null, excludedFromAutomation: true },
    }),
    prisma.subscriber.count({ where: { shopId, deletedAt: null } }),
    prisma.subscriber.count({
      where: {
        shopId,
        deletedAt: null,
        eligible: true,
        isSuppressed: false,
        paused: false,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      },
    }),
    prisma.emailJob.count({
      where: { shopId, status: EmailJobStatus.ACCEPTED },
    }),
    prisma.emailEvent.count({
      where: { shopId, type: EmailEventType.DELIVERED },
    }),
    prisma.emailJob.count({
      where: { shopId, status: EmailJobStatus.FAILED },
    }),
    prisma.emailJob.count({
      where: {
        shopId,
        status: {
          in: [
            EmailJobStatus.PENDING,
            EmailJobStatus.PROCESSING,
            EmailJobStatus.RETRY_SCHEDULED,
          ],
        },
      },
    }),
    prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: {
        lastSyncAt: true,
        timezone: true,
        automationSettings: {
          select: {
            automationEnabled: true,
            dryRun: true,
            emailProviderLabel: true,
          },
        },
      },
    }),
    prisma.syncJob.findFirst({
      where: { shopId, type: SyncJobType.PRODUCTS },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        stats: true,
        updatedAt: true,
      },
    }),
    prisma.syncJob.findFirst({
      where: { shopId, type: SyncJobType.CUSTOMERS },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        updatedAt: true,
      },
    }),
    prisma.emailJob.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        dryRun: true,
        attemptCount: true,
        providerMessageId: true,
        subscriber: {
          select: {
            emailNormalized: true,
            currentCycleNumber: true,
          },
        },
        products: {
          select: { title: true },
          orderBy: { position: "asc" },
          take: 3,
        },
      },
    }),
    prisma.emailEvent.findMany({
      where: { shopId, occurredAt: { gte: weekAgo } },
      orderBy: { occurredAt: "desc" },
      take: 12,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        providerMessageId: true,
      },
    }),
    prisma.$queryRaw<Array<{ day: Date; status: string; count: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS day,
             status::text AS status,
             COUNT(*)::bigint AS count
      FROM "EmailJob"
      WHERE "shopId" = ${shopId}
        AND "createdAt" >= ${weekAgo}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `,
  ]);

  const dayKeys: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const chart = dayKeys.map((key) => {
    const accepted = Number(
      deliveryByDay.find(
        (r) =>
          r.status === EmailJobStatus.ACCEPTED &&
          new Date(r.day).toISOString().slice(0, 10) === key,
      )?.count ?? 0n,
    );
    const failed = Number(
      deliveryByDay.find(
        (r) =>
          r.status === EmailJobStatus.FAILED &&
          new Date(r.day).toISOString().slice(0, 10) === key,
      )?.count ?? 0n,
    );
    const pending = Number(
      deliveryByDay.find(
        (r) =>
          (r.status === EmailJobStatus.PENDING ||
            r.status === EmailJobStatus.PROCESSING ||
            r.status === EmailJobStatus.RETRY_SCHEDULED) &&
          new Date(r.day).toISOString().slice(0, 10) === key,
      )?.count ?? 0n,
    );
    return { day: key, accepted, failed, pending };
  });

  const sent24h = await prisma.emailJob.count({
    where: {
      shopId,
      status: EmailJobStatus.ACCEPTED,
      completedAt: { gte: dayAgo },
    },
  });

  return {
    totals: {
      totalProducts,
      eligibleProducts,
      excludedProducts,
      totalSubscribers,
      activeAutomationSubscribers,
      emailsSent,
      emailsDelivered,
      emailsFailed,
      pendingJobs,
      sent24h,
      deliveryRate: ratePct(emailsDelivered, emailsSent),
      failureRate: ratePct(emailsFailed, emailsSent + emailsFailed),
    },
    sync: {
      lastSyncAt: shop.lastSyncAt?.toISOString() ?? null,
      timezone: shop.timezone,
      automationEnabled: shop.automationSettings?.automationEnabled ?? false,
      dryRun: shop.automationSettings?.dryRun ?? true,
      emailProviderLabel:
        shop.automationSettings?.emailProviderLabel ?? "dry_run",
      productSync: latestProductSync
        ? {
            status: latestProductSync.status,
            updatedAt: latestProductSync.updatedAt.toISOString(),
            completedAt: latestProductSync.completedAt?.toISOString() ?? null,
            lastError: latestProductSync.lastError,
            running: latestProductSync.status === SyncJobStatus.RUNNING,
          }
        : null,
      customerSync: latestCustomerSync
        ? {
            status: latestCustomerSync.status,
            updatedAt: latestCustomerSync.updatedAt.toISOString(),
            completedAt: latestCustomerSync.completedAt?.toISOString() ?? null,
            lastError: latestCustomerSync.lastError,
          }
        : null,
    },
    chart,
    recentActivity: [
      ...recentJobs.map((j) => ({
        id: j.id,
        kind: "email_job" as const,
        at: (j.completedAt ?? j.createdAt).toISOString(),
        label: `Email ${j.status.toLowerCase()} · cycle ${j.subscriber.currentCycleNumber}${j.dryRun ? " · dry-run" : ""}`,
        detail: j.products.map((p) => p.title).join(", ") || null,
      })),
      ...recentEvents.map((e) => ({
        id: e.id,
        kind: "email_event" as const,
        at: e.occurredAt.toISOString(),
        label: `Event ${e.type.toLowerCase()}`,
        detail: e.providerMessageId,
      })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 12),
  };
}
