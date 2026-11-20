import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import {
  listTestSubscribers,
  prepareTestBatch,
  previewRandomSelection,
} from "../services/selection-preview.server";
import { formatMoney } from "../utils/admin-format";
import { toMerchantSafeError } from "../lib/safe-error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const url = new URL(request.url);
  const subscribers = await listTestSubscribers(
    shopRow.id,
    url.searchParams.get("q"),
  );
  return {
    shop,
    subscribers,
    defaults: {
      productsPerEmail: shopRow.automationSettings?.productsPerEmail ?? 6,
      inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
      intervalDays: shopRow.automationSettings?.intervalDays ?? 3,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const subscriberId = String(form.get("subscriberId") ?? "");
  const batchSize = Number(form.get("batchSize") ?? 6);

  if (!subscriberId) {
    return { ok: false, intent, error: "Select a test customer" };
  }

  try {
    if (intent === "preview") {
      const selection = await previewRandomSelection({
        shopId: shopRow.id,
        subscriberId,
        batchSize,
        inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
      });
      return {
        ok: true,
        intent,
        selection: selection
          ? {
              cycleNumber: selection.cycleNumber,
              startedNewCycle: selection.startedNewCycle,
              products: selection.products.map((p) => ({
                id: p.id,
                title: p.title,
                handle: p.handle,
                imageUrl: p.imageUrl,
                price: p.priceMin?.toString() ?? null,
                currencyCode: p.currencyCode,
              })),
            }
          : null,
      };
    }

    if (intent === "prepare") {
      if (String(form.get("confirm") ?? "") !== "1") {
        return {
          ok: false,
          intent,
          error: "Confirm preparing the test batch",
        };
      }
      const result = await prepareTestBatch({
        client: admin,
        shopDomain: shop,
        shopId: shopRow.id,
        subscriberId,
        batchSize,
        inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
        intervalDays: shopRow.automationSettings?.intervalDays ?? 3,
      });
      if (!result.ok) {
        return {
          ok: false,
          intent,
          error: "Could not reserve a test batch",
          detail: result.reserved.status,
        };
      }
      return {
        ok: true,
        intent,
        flowStatus: result.flow.status,
        batchId:
          result.flow.status === "ready" || result.flow.status === "acknowledged"
            ? result.flow.batchId
            : result.reserved.status === "reserved" ||
                result.reserved.status === "active_job_exists"
              ? result.reserved.job.id
              : null,
      };
    }
  } catch (error) {
    return {
      ok: false,
      intent,
      error: toMerchantSafeError(error, "Selection failed"),
    };
  }

  return { ok: false, intent, error: "unknown_intent" };
};

export default function RandomSelectionPage() {
  const { subscribers, defaults } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [subscriberId, setSubscriberId] = useState(
    subscribers[0]?.id ?? "",
  );
  const [batchSize, setBatchSize] = useState(String(defaults.productsPerEmail));

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      return;
    }
    if (fetcher.data.intent === "preview") {
      shopify.toast.show(
        fetcher.data.selection
          ? `Preview · ${fetcher.data.selection.products.length} product(s)`
          : "No eligible products for preview",
      );
    }
    if (fetcher.data.intent === "prepare" && fetcher.data.ok) {
      shopify.toast.show(
        `Test batch ${fetcher.data.flowStatus}${fetcher.data.batchId ? ` · ${fetcher.data.batchId}` : ""}`,
      );
    }
  }, [fetcher.data, shopify]);

  const preview = fetcher.data?.intent === "preview" ? fetcher.data.selection : null;

  return (
    <s-page heading="Random Selection">
      <s-section heading="Test selection">
        <s-paragraph>
          Preview random products for one subscribed customer. Preparing a test
          batch writes Shopify tags/metafields — it does not send email from
          this app. Live Messaging still requires your Flow Workflow B and
          explicit approval before real sends.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <s-select
            label="Test customer"
            name="subscriberId"
            value={subscriberId}
            onChange={(event) =>
              setSubscriberId(String(event.currentTarget.value ?? ""))
            }
          >
            <s-option value="">Select…</s-option>
            {subscribers.map((s) => (
              <s-option key={s.id} value={s.id}>
                {s.emailNormalized}
                {s.paused ? " (paused)" : ""}
                {!s.eligible ? " (ineligible)" : ""}
              </s-option>
            ))}
          </s-select>
          <s-number-field
            label="Product quantity"
            name="batchSize"
            min={1}
            max={6}
            value={batchSize}
            onChange={(event) =>
              setBatchSize(String(event.currentTarget.value ?? "6"))
            }
          />
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "preview",
                    subscriberId,
                    batchSize,
                  },
                  { method: "POST" },
                )
              }
            >
              Preview random products
            </s-button>
            <s-button
              variant="secondary"
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "preview",
                    subscriberId,
                    batchSize,
                  },
                  { method: "POST" },
                )
              }
            >
              Regenerate selection
            </s-button>
            <s-button
              variant="secondary"
              onClick={() => {
                if (
                  !window.confirm(
                    "Prepare a test batch? This writes customer tags and metafields. It will not send email from XLOXI. Shopify Messaging may send if Workflow B is live.",
                  )
                ) {
                  return;
                }
                fetcher.submit(
                  {
                    intent: "prepare",
                    subscriberId,
                    batchSize,
                    confirm: "1",
                  },
                  { method: "POST" },
                );
              }}
            >
              Prepare test batch
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Preview">
        {!preview ? (
          <s-banner tone="info" heading="No preview yet">
            Run a preview to see products before reservation. Preview does not
            write history or tags.
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Cycle {preview.cycleNumber}
              {preview.startedNewCycle ? " · new cycle" : ""} ·{" "}
              {preview.products.length} product(s)
            </s-paragraph>
            {preview.products.map((p) => (
              <s-box
                key={p.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  {p.imageUrl ? (
                    <s-thumbnail
                      src={p.imageUrl}
                      alt={p.title}
                      size="small"
                    />
                  ) : (
                    <s-thumbnail alt="" size="small" />
                  )}
                  <s-stack direction="block" gap="small-200">
                    <s-paragraph>
                      <strong>{p.title}</strong>
                    </s-paragraph>
                    <s-text color="subdued">
                      {p.handle ? `xloxi-pick:${p.handle}` : "missing handle"}
                      {" · "}
                      {formatMoney(p.price, p.currencyCode)}
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
