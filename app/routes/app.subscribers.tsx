import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  MarketingConsentState,
  type MarketingConsentStateValue,
} from "../lib/domain-enums";
import { requireAdminAuth } from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import { getSubscriberCounts } from "../services/customer-sync.server";
import {
  getSubscriberProductHistory,
  listAdminSubscribers,
  setSubscriberPaused,
} from "../services/admin-subscribers.server";
import {
  enqueueCustomerSyncJob,
  processCustomerSyncJobTick,
} from "../jobs/customer-sync.server";
import {
  clampPage,
  formatDateTime,
  parseBoolParam,
} from "../utils/admin-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const url = new URL(request.url);

  const consentParam = url.searchParams.get("consent");
  const historyId = url.searchParams.get("history");

  const list = await listAdminSubscribers({
    shopId: shopRow.id,
    q: url.searchParams.get("q"),
    eligible: parseBoolParam(url.searchParams.get("eligible")),
    suppressed: parseBoolParam(url.searchParams.get("suppressed")),
    paused: parseBoolParam(url.searchParams.get("paused")),
    consent:
      consentParam &&
      (Object.values(MarketingConsentState) as string[]).includes(consentParam)
        ? (consentParam as MarketingConsentStateValue)
        : null,
    page: clampPage(url.searchParams.get("page")),
    pageSize: 25,
  });

  const counts = await getSubscriberCounts(shopRow.id);
  const history = historyId
    ? await getSubscriberProductHistory(shopRow.id, historyId)
    : null;

  return { shop, counts, list, history };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "sync_tick");

  if (intent === "sync_start") {
    const job = await enqueueCustomerSyncJob({
      shopDomain: shop,
      fullReconcile: true,
    });
    const result = await processCustomerSyncJobTick({
      shopDomain: shop,
      client: admin,
      jobId: job.id,
    });
    return {
      ok: true,
      intent,
      hasMore: result.stats.hasMore,
      jobStatus: result.job.status,
      counts: result.counts,
      stats: result.stats,
    };
  }

  if (intent === "sync_tick") {
    const result = await processCustomerSyncJobTick({
      shopDomain: shop,
      client: admin,
    });
    return {
      ok: true,
      intent,
      hasMore: result.stats.hasMore,
      jobStatus: result.job.status,
      counts: result.counts,
      stats: result.stats,
    };
  }

  if (intent === "pause" || intent === "resume") {
    const subscriberId = String(form.get("subscriberId") ?? "");
    const ok = await setSubscriberPaused(
      shopRow.id,
      subscriberId,
      intent === "pause",
    );
    return { ok, intent, subscriberId };
  }

  return { ok: false, intent, error: "unknown_intent" };
};

export default function SubscribersPage() {
  const { counts, list, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [params] = useSearchParams();
  const [confirmPauseId, setConfirmPauseId] = useState<string | null>(null);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const liveCounts = fetcher.data?.counts ?? counts;
  const hasMore = fetcher.data?.hasMore === true;
  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    if (fetcher.data.intent === "sync_start" || fetcher.data.intent === "sync_tick") {
      shopify.toast.show(
        fetcher.data.hasMore
          ? "Subscriber sync in progress"
          : "Subscriber sync complete",
      );
    } else if (fetcher.data.intent === "pause") {
      shopify.toast.show("Subscriber paused");
    } else if (fetcher.data.intent === "resume") {
      shopify.toast.show("Subscriber resumed");
    }
    revalidator.revalidate();
  }, [fetcher.data, shopify, revalidator]);

  useEffect(() => {
    if (!hasMore || isLoading) return;
    const timer = window.setTimeout(() => {
      fetcher.submit({ intent: "sync_tick" }, { method: "POST" });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [hasMore, isLoading, fetcher]);

  const queryWith = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    return `/app/subscribers?${next.toString()}`;
  };

  return (
    <s-page heading="Subscribers">
      <s-button
        slot="primary-action"
        onClick={() =>
          fetcher.submit({ intent: "sync_start" }, { method: "POST" })
        }
        {...(isLoading ? { loading: true } : {})}
      >
        Sync subscribers
      </s-button>

      <s-section heading="Counts">
        <s-stack direction="inline" gap="base">
          <s-paragraph>
            Total: <strong>{liveCounts.total}</strong>
          </s-paragraph>
          <s-paragraph>
            Eligible: <strong>{liveCounts.eligible}</strong>
          </s-paragraph>
          <s-paragraph>
            SUBSCRIBED: <strong>{liveCounts.subscribed}</strong>
          </s-paragraph>
          <s-paragraph>
            Suppressed: <strong>{liveCounts.suppressed}</strong>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Filters">
        <Form method="get">
          <s-stack direction="block" gap="base">
            <s-search-field
              label="Search"
              name="q"
              defaultValue={params.get("q") ?? ""}
              placeholder="email fragment or customer GID"
            />
            <s-stack direction="inline" gap="base">
              <s-select
                label="Eligible"
                name="eligible"
                value={params.get("eligible") ?? ""}
              >
                <s-option value="">Any</s-option>
                <s-option value="true">Yes</s-option>
                <s-option value="false">No</s-option>
              </s-select>
              <s-select
                label="Consent"
                name="consent"
                value={params.get("consent") ?? ""}
              >
                <s-option value="">Any</s-option>
                {Object.values(MarketingConsentState).map((state) => (
                  <s-option key={state} value={state}>
                    {state}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="Suppressed"
                name="suppressed"
                value={params.get("suppressed") ?? ""}
              >
                <s-option value="">Any</s-option>
                <s-option value="true">Yes</s-option>
                <s-option value="false">No</s-option>
              </s-select>
              <s-select
                label="Paused"
                name="paused"
                value={params.get("paused") ?? ""}
              >
                <s-option value="">Any</s-option>
                <s-option value="true">Yes</s-option>
                <s-option value="false">No</s-option>
              </s-select>
            </s-stack>
            <s-button type="submit" variant="secondary">
              Apply filters
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Subscribers (${list.total})`}>
        {list.rows.length === 0 ? (
          <s-banner tone="info" heading="No subscribers yet">
            No subscribers match these filters. Sync customers with marketing
            consent to populate this list.
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            {list.rows.map((row) => (
              <s-box
                key={row.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="small-200">
                    <s-paragraph>
                      <strong>{row.emailMasked}</strong>
                    </s-paragraph>
                    <s-badge>{row.marketingConsentState}</s-badge>
                    <s-badge tone={row.eligible ? "success" : "caution"}>
                      {row.eligible ? "eligible" : "not eligible"}
                    </s-badge>
                    {row.isSuppressed ? (
                      <s-badge tone="critical">suppressed</s-badge>
                    ) : null}
                    {row.paused ? (
                      <s-badge tone="warning">paused</s-badge>
                    ) : null}
                  </s-stack>
                  <s-text color="subdued">
                    Cycle {row.currentCycleNumber} · sent this cycle{" "}
                    {row.productsSentInCycle} · total history{" "}
                    {row.productsSentTotal}
                  </s-text>
                  <s-text color="subdued">
                    Last email: {formatDateTime(row.lastSuccessfulEmailAt)} ·
                    Last processed: {formatDateTime(row.lastProcessedAt)} ·
                    Next: {formatDateTime(row.nextEmailAt)}
                  </s-text>
                  <s-stack direction="inline" gap="base">
                    {row.paused ? (
                      <s-button
                        variant="secondary"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "resume", subscriberId: row.id },
                            { method: "POST" },
                          )
                        }
                      >
                        Resume
                      </s-button>
                    ) : (
                      <s-button
                        variant="secondary"
                        onClick={() => setConfirmPauseId(row.id)}
                      >
                        Pause
                      </s-button>
                    )}
                    <s-link href={queryWith({ history: row.id, page: null })}>
                      View product history
                    </s-link>
                  </s-stack>
                  {confirmPauseId === row.id ? (
                    <s-box padding="base" borderWidth="base" borderRadius="base">
                      <s-paragraph>
                        Pause emails for {row.emailMasked}? They will be skipped
                        by the scheduler until resumed.
                      </s-paragraph>
                      <s-stack direction="inline" gap="base">
                        <s-button
                          onClick={() => {
                            fetcher.submit(
                              { intent: "pause", subscriberId: row.id },
                              { method: "POST" },
                            );
                            setConfirmPauseId(null);
                          }}
                        >
                          Confirm pause
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() => setConfirmPauseId(null)}
                        >
                          Cancel
                        </s-button>
                      </s-stack>
                    </s-box>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}

        <s-stack direction="inline" gap="base">
          {list.page > 1 ? (
            <s-link
              href={queryWith({ page: String(list.page - 1), history: null })}
            >
              Previous
            </s-link>
          ) : null}
          <s-paragraph>
            Page {list.page} / {totalPages}
          </s-paragraph>
          {list.page < totalPages ? (
            <s-link
              href={queryWith({ page: String(list.page + 1), history: null })}
            >
              Next
            </s-link>
          ) : null}
        </s-stack>
      </s-section>

      {history ? (
        <s-section heading={`Product history · ${history.subscriber.emailMasked}`}>
          <s-paragraph>
            Cycle {history.subscriber.currentCycleNumber}
            {history.subscriber.paused ? " · paused" : ""} · {history.total}{" "}
            products recorded
          </s-paragraph>
          {history.rows.length === 0 ? (
            <s-paragraph>No products sent to this subscriber yet.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-200">
              {history.rows.map((row) => (
                <s-box
                  key={row.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-paragraph>
                    <strong>{row.product.title}</strong> · cycle{" "}
                    {row.cycleNumber} · {formatDateTime(row.sentAt)}
                  </s-paragraph>
                </s-box>
              ))}
            </s-stack>
          )}
          <s-link href={queryWith({ history: null })}>Close history</s-link>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
