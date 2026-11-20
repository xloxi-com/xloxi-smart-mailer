import { EmailEventType, EmailJobStatus } from "../lib/prisma.server";
import prisma from "../db.server";
import { ratePct } from "../utils/admin-format";

export type AnalyticsRange = {
  shopId: string;
  from: Date;
  to: Date;
};

function parseRange(
  fromParam: string | null,
  toParam: string | null,
): { from: Date; to: Date } {
  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const fallbackTo = new Date();
    return {
      from: new Date(fallbackTo.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: fallbackTo,
    };
  }
  return { from, to };
}

export function resolveAnalyticsRange(
  fromParam: string | null,
  toParam: string | null,
) {
  return parseRange(fromParam, toParam);
}

export async function getAnalytics(options: AnalyticsRange) {
  const { shopId, from, to } = options;
  const createdInRange = { gte: from, lte: to };

  const [
    emailsSent,
    emailsFailed,
    delivered,
    bounced,
    clicked,
    unsubscribed,
    opened,
    jobsByStatus,
  ] = await Promise.all([
    prisma.emailJob.count({
      where: {
        shopId,
        status: EmailJobStatus.ACCEPTED,
        completedAt: createdInRange,
      },
    }),
    prisma.emailJob.count({
      where: {
        shopId,
        status: EmailJobStatus.FAILED,
        updatedAt: createdInRange,
      },
    }),
    prisma.emailEvent.count({
      where: {
        shopId,
        type: EmailEventType.DELIVERED,
        occurredAt: createdInRange,
      },
    }),
    prisma.emailEvent.count({
      where: {
        shopId,
        type: EmailEventType.BOUNCED,
        occurredAt: createdInRange,
      },
    }),
    prisma.emailEvent.count({
      where: {
        shopId,
        type: EmailEventType.CLICKED,
        occurredAt: createdInRange,
      },
    }),
    prisma.emailEvent.count({
      where: {
        shopId,
        type: EmailEventType.UNSUBSCRIBED,
        occurredAt: createdInRange,
      },
    }),
    prisma.emailEvent.count({
      where: {
        shopId,
        type: EmailEventType.OPENED,
        occurredAt: createdInRange,
      },
    }),
    prisma.emailJob.groupBy({
      by: ["status"],
      where: { shopId, createdAt: createdInRange },
      _count: { _all: true },
    }),
  ]);

  const clickSupported = clicked > 0 || opened > 0;

  return {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    metrics: {
      emailsSent,
      emailsFailed,
      delivered,
      bounced,
      clicked,
      unsubscribed,
      opened,
      deliveryRate: ratePct(delivered, emailsSent),
      bounceRate: ratePct(bounced, emailsSent),
      clickRate: clickSupported ? ratePct(clicked, emailsSent) : null,
      unsubscribeRate: ratePct(unsubscribed, emailsSent),
      clickSupported,
    },
    jobsByStatus: jobsByStatus.map((r) => ({
      status: r.status,
      count: r._count._all,
    })),
  };
}
