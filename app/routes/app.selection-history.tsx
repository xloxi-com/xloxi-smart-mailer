import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import prisma from "../db.server";
import { clampPage, formatDateTime } from "../utils/admin-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const url = new URL(request.url);
  const page = clampPage(url.searchParams.get("page"));
  const pageSize = 25;
  const where = { shopId: shopRow.id };

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
        flowStatus: true,
        triggerSource: true,
        cycleNumber: true,
        createdAt: true,
        flowReadyAt: true,
        acknowledgedAt: true,
        dryRun: true,
        subscriber: { select: { emailNormalized: true } },
        products: {
          select: { title: true, handle: true },
          orderBy: { position: "asc" },
          take: 6,
        },
      },
    }),
  ]);

  return {
    page,
    pageSize,
    total,
    rows: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      flowReadyAt: r.flowReadyAt?.toISOString() ?? null,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    })),
  };
};

export default function SelectionHistoryPage() {
  const { rows, page, pageSize, total } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const queryWithPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    return `/app/selection-history?${next.toString()}`;
  };

  return (
    <s-page heading="Selection History">
      <s-section heading={`Batches (${total})`}>
        <s-paragraph>
          Historical selection batches (including legacy email jobs). Delivery
          happens in Shopify Messaging — acknowledgement is not delivery proof.
        </s-paragraph>
        {rows.length === 0 ? (
          <s-banner tone="info" heading="No selection batches yet">
            Batches appear here after Flow request processing or a test
            selection.
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            {rows.map((row) => (
              <s-box
                key={row.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="small-200">
                    <s-paragraph>
                      <strong>{row.subscriber.emailNormalized}</strong>
                    </s-paragraph>
                    <s-badge>{row.flowStatus}</s-badge>
                    <s-badge tone="info">{row.status}</s-badge>
                    {row.triggerSource ? (
                      <s-badge>{row.triggerSource}</s-badge>
                    ) : null}
                  </s-stack>
                  <s-text color="subdued">
                    Cycle {row.cycleNumber} · created{" "}
                    {formatDateTime(row.createdAt)}
                    {row.acknowledgedAt
                      ? ` · ack ${formatDateTime(row.acknowledgedAt)}`
                      : ""}
                  </s-text>
                  <s-text color="subdued">
                    {row.products
                      .map((p) => p.handle ?? p.title)
                      .join(", ") || "No products"}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
        <s-stack direction="inline" gap="base">
          {page > 1 ? (
            <s-link href={queryWithPage(page - 1)}>Previous</s-link>
          ) : null}
          <s-paragraph>
            Page {page} / {totalPages}
          </s-paragraph>
          {page < totalPages ? (
            <s-link href={queryWithPage(page + 1)}>Next</s-link>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
