import { useEffect, useRef, useState } from "react";
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
  requireAdminAuth,
  throwReauthorizeIfSessionInvalid,
} from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import {
  getExcludedCollections,
  listAdminProducts,
  saveExcludedCollections,
  setProductsExcluded,
} from "../services/admin-products.server";
import {
  cancelStaleProductSyncJobs,
  enqueueProductSyncJob,
  getProductSyncStatus,
  processProductSyncJobTick,
} from "../jobs/product-sync.server";
import {
  clampPage,
  formatDateTime,
  formatMoney,
  parseBoolParam,
} from "../utils/admin-format";
import { toMerchantSafeError } from "../lib/safe-error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, missingScopes } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const url = new URL(request.url);

  await cancelStaleProductSyncJobs(shop);

  const list = await listAdminProducts({
    shopId: shopRow.id,
    q: url.searchParams.get("q"),
    eligible: parseBoolParam(url.searchParams.get("eligible")),
    inStock: parseBoolParam(url.searchParams.get("inStock")),
    excluded: parseBoolParam(url.searchParams.get("excluded")),
    page: clampPage(url.searchParams.get("page")),
    pageSize: 25,
  });

  const [excludedCollections, syncStatus] = await Promise.all([
    getExcludedCollections(shopRow.id),
    getProductSyncStatus(shop),
  ]);

  const latestJob = syncStatus.latestJob;
  const syncError =
    latestJob?.status === "FAILED" && latestJob.lastError
      ? toMerchantSafeError(latestJob.lastError)
      : latestJob?.status === "CANCELLED" && latestJob.lastError
        ? toMerchantSafeError(latestJob.lastError)
        : null;

  return {
    shop,
    list,
    excludedCollections,
    syncStatus: {
      mirroredProducts: syncStatus.mirroredProducts,
      eligibleProducts: syncStatus.eligibleProducts,
      lastSyncAt: syncStatus.lastSyncAt,
      latestJobStatus: latestJob?.status ?? null,
    },
    syncError,
    missingScopes,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "sync_start" || intent === "sync_tick") {
    try {
      const job =
        intent === "sync_start"
          ? await enqueueProductSyncJob({
              shopDomain: shop,
              fullReconcile: true,
            })
          : undefined;
      const result = await processProductSyncJobTick({
        shopDomain: shop,
        client: admin,
        jobId: job?.id,
      });
      const failed = result.job.status === "FAILED";
      const jobStats =
        result.job.stats && typeof result.job.stats === "object"
          ? (result.job.stats as Record<string, unknown>)
          : {};
      return {
        ok: !failed,
        intent,
        hasMore: result.stats.hasMore && result.job.status === "RUNNING",
        jobStatus: result.job.status,
        stats: {
          processed:
            typeof jobStats.processed === "number"
              ? jobStats.processed
              : result.stats.processed,
          upserted:
            typeof jobStats.upserted === "number"
              ? jobStats.upserted
              : result.stats.upserted,
          eligible:
            typeof jobStats.eligible === "number"
              ? jobStats.eligible
              : result.stats.eligible,
          errors:
            typeof jobStats.errors === "number"
              ? jobStats.errors
              : result.stats.errors,
          shopifyProductCount:
            typeof jobStats.shopifyProductCount === "number"
              ? jobStats.shopifyProductCount
              : result.stats.shopifyProductCount,
          phase: result.stats.phase,
          mirroredProducts: result.progress.mirroredProducts,
        },
        error: failed
          ? result.job.lastError ?? "Product synchronization failed"
          : null,
      };
    } catch (error) {
      // Stale/revoked offline tokens must re-auth — not a toast.
      throwReauthorizeIfSessionInvalid(error, shop);
      return {
        ok: false,
        intent,
        hasMore: false,
        jobStatus: "FAILED",
        error: toMerchantSafeError(error, "Product synchronization failed"),
      };
    }
  }

  if (intent === "exclude" || intent === "include") {
    const ids = form.getAll("productId").map(String).filter(Boolean);
    const count = await setProductsExcluded(
      shopRow.id,
      ids,
      intent === "exclude",
    );
    return { ok: true, intent, count };
  }

  if (intent === "save_collections") {
    const raw = String(form.get("collectionGids") ?? "");
    const gids = raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const saved = await saveExcludedCollections(shop, gids);
    return { ok: true, intent, count: saved.length };
  }

  return { ok: false, intent, error: "unknown_intent" };
};

export default function ProductsPage() {
  const { list, excludedCollections, syncStatus, syncError, missingScopes } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const syncStartedAt = useRef<number | null>(null);
  const lastHandledData = useRef<unknown>(null);

  const isSyncIntent =
    fetcher.formData?.get("intent") === "sync_start" ||
    fetcher.formData?.get("intent") === "sync_tick" ||
    fetcher.data?.intent === "sync_start" ||
    fetcher.data?.intent === "sync_tick";
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const syncing =
    isSyncIntent &&
    (isLoading || fetcher.data?.hasMore === true);
  const hasMore = fetcher.data?.hasMore === true;
  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const syncStats = fetcher.data?.stats;

  useEffect(() => {
    if (!fetcher.data || fetcher.data === lastHandledData.current) return;
    lastHandledData.current = fetcher.data;

    if (
      (fetcher.data.intent === "sync_start" ||
        fetcher.data.intent === "sync_tick") &&
      !fetcher.data.ok
    ) {
      syncStartedAt.current = null;
      shopify.toast.show(
        fetcher.data.error ?? "Product synchronization failed",
        { isError: true },
      );
      revalidator.revalidate();
      return;
    }
    if (!fetcher.data.ok) return;

    if (fetcher.data.intent === "sync_start" || fetcher.data.intent === "sync_tick") {
      if (!fetcher.data.hasMore) {
        syncStartedAt.current = null;
        shopify.toast.show(
          fetcher.data.jobStatus === "FAILED"
            ? "Product sync finished with errors"
            : `Product sync complete · ${fetcher.data.stats?.mirroredProducts ?? fetcher.data.stats?.processed ?? 0} products`,
        );
        revalidator.revalidate();
      }
      return;
    }

    if (fetcher.data.intent === "exclude") {
      shopify.toast.show(`Excluded ${fetcher.data.count ?? 0} product(s)`);
      setSelected([]);
    } else if (fetcher.data.intent === "include") {
      shopify.toast.show(`Included ${fetcher.data.count ?? 0} product(s)`);
      setSelected([]);
    } else if (fetcher.data.intent === "save_collections") {
      shopify.toast.show("Excluded collections saved");
    }
    revalidator.revalidate();
  }, [fetcher.data, shopify, revalidator]);

  useEffect(() => {
    if (!hasMore || isLoading) return;
    const timer = window.setTimeout(() => {
      fetcher.submit({ intent: "sync_tick" }, { method: "POST" });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hasMore, isLoading, fetcher]);

  // Hard stop if a single POST hangs (proxy/tunnel timeout).
  useEffect(() => {
    if (!isLoading || !isSyncIntent) return;
    if (syncStartedAt.current == null) syncStartedAt.current = Date.now();
    const timer = window.setTimeout(() => {
      if (!isLoading) return;
      syncStartedAt.current = null;
      shopify.toast.show(
        "Product sync timed out. Click Sync products to continue.",
        { isError: true },
      );
      revalidator.revalidate();
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [isLoading, isSyncIntent, shopify, revalidator]);

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const queryWithPage = (page: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    return `/app/products?${next.toString()}`;
  };

  const startSync = () => {
    if (syncing) return;
    syncStartedAt.current = Date.now();
    fetcher.submit({ intent: "sync_start" }, { method: "POST" });
  };

  return (
    <s-page heading="Products">
      <s-button
        slot="primary-action"
        onClick={startSync}
        {...(syncing ? { loading: true, disabled: true } : {})}
      >
        {syncing ? "Syncing…" : "Sync products"}
      </s-button>

      {syncing ? (
        <s-banner tone="info" heading="Product sync running">
          {syncStats?.processed != null
            ? `Imported ${syncStats.processed}${
                syncStats.shopifyProductCount != null
                  ? ` / ${syncStats.shopifyProductCount}`
                  : ""
              } products…`
            : "Importing your Online Store catalog…"}
        </s-banner>
      ) : null}

      <s-section heading="Filters">
        <Form method="get">
          <s-stack direction="block" gap="base">
            <s-search-field
              label="Search"
              name="q"
              defaultValue={params.get("q") ?? ""}
              placeholder="Title, handle, or product GID"
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
                label="In stock"
                name="inStock"
                value={params.get("inStock") ?? ""}
              >
                <s-option value="">Any</s-option>
                <s-option value="true">Yes</s-option>
                <s-option value="false">No</s-option>
              </s-select>
              <s-select
                label="Excluded"
                name="excluded"
                value={params.get("excluded") ?? ""}
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

      {missingScopes.length > 0 ? (
        <s-banner tone="warning" heading="App permissions need an update">
          Missing scopes: {missingScopes.join(", ")}. Close this app and open it
          again from Apps — Shopify will ask you to approve the new permissions.
        </s-banner>
      ) : null}

      {syncError ? (
        <s-banner tone="critical" heading="Product sync issue">
          {syncError} Click Sync products to retry.
        </s-banner>
      ) : null}

      <s-section
        heading={`Catalog (${list.total} · ${syncStatus.eligibleProducts} eligible)`}
      >
        {selected.length > 0 ? (
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => {
                if (
                  !window.confirm(
                    `Exclude ${selected.length} selected product(s) from automation?`,
                  )
                ) {
                  return;
                }
                const fd = new FormData();
                fd.set("intent", "exclude");
                selected.forEach((id) => fd.append("productId", id));
                fetcher.submit(fd, { method: "POST" });
              }}
            >
              Exclude selected
            </s-button>
            <s-button
              variant="secondary"
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "include");
                selected.forEach((id) => fd.append("productId", id));
                fetcher.submit(fd, { method: "POST" });
              }}
            >
              Include selected
            </s-button>
          </s-stack>
        ) : null}

        {list.rows.length === 0 ? (
          <s-banner tone="info" heading="No products yet">
            No products match these filters. Run a product sync to import your
            Online Store catalog.
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            {list.rows.map((row) => (
              <s-box
                key={row.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-checkbox
                    accessibilityLabel={`Select ${row.title}`}
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                  <s-thumbnail
                    src={row.imageUrl ?? undefined}
                    alt={row.title}
                    size="small"
                  />
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" gap="small-200">
                      <s-paragraph>
                        <strong>{row.title}</strong>
                      </s-paragraph>
                      {row.excludedFromAutomation ? (
                        <s-badge tone="warning">excluded</s-badge>
                      ) : null}
                      <s-badge tone={row.eligible ? "success" : "caution"}>
                        {row.eligible ? "eligible" : "not eligible"}
                      </s-badge>
                      <s-badge tone={row.inStock ? "success" : "critical"}>
                        {row.inStock ? "in stock" : "out of stock"}
                      </s-badge>
                    </s-stack>
                    <s-text color="subdued">
                      {formatMoney(row.priceMin, row.currencyCode)}
                      {row.priceMax && row.priceMax !== row.priceMin
                        ? ` – ${formatMoney(row.priceMax, row.currencyCode)}`
                        : ""}
                      {" · "}
                      stock {row.totalInventory}
                      {" · "}
                      synced {formatDateTime(row.lastSyncedAt)}
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}

        <s-stack direction="inline" gap="base">
          {list.page > 1 ? (
            <s-link href={queryWithPage(list.page - 1)}>Previous</s-link>
          ) : null}
          <s-paragraph>
            Page {list.page} / {totalPages}
          </s-paragraph>
          {list.page < totalPages ? (
            <s-link href={queryWithPage(list.page + 1)}>Next</s-link>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Exclude collections">
        <Form
          method="post"
          onSubmit={(e) => {
            if (
              !window.confirm(
                "Save excluded collection GIDs? Products in these collections will be treated as excluded once collection membership is available on sync.",
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="save_collections" />
          <s-stack direction="block" gap="base">
            <s-text-area
              label="Collection GIDs (one per line)"
              name="collectionGids"
              rows={4}
              defaultValue={excludedCollections.join("\n")}
              placeholder="gid://shopify/Collection/123"
            />
            <s-button type="submit" variant="secondary">
              Save excluded collections
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
