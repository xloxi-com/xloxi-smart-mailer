import { useEffect } from "react";
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
import { getFlowDashboardStats } from "../services/admin-flow-dashboard.server";
import { ensureXloxiCustomerMetafieldDefinitions } from "../services/customer-tags-metafields.server";
import {
  XLOXI_METAFIELD_KEYS,
  XLOXI_METAFIELD_NAMESPACE,
  XLOXI_TAG_PICK_PREFIX,
  XLOXI_TAG_READY,
  XLOXI_TAG_REQUEST,
} from "../services/flow-tags.server";
import { formatDateTime } from "../utils/admin-format";
import { toMerchantSafeError } from "../lib/safe-error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const stats = await getFlowDashboardStats(shopRow.id);
  return {
    shop,
    stats,
    tags: {
      request: XLOXI_TAG_REQUEST,
      ready: XLOXI_TAG_READY,
      pickPrefix: XLOXI_TAG_PICK_PREFIX,
    },
    metafields: {
      namespace: XLOXI_METAFIELD_NAMESPACE,
      keys: Object.values(XLOXI_METAFIELD_KEYS),
      processedBatchId: XLOXI_METAFIELD_KEYS.processedBatchId,
      pendingBatchId: XLOXI_METAFIELD_KEYS.pendingBatchId,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdminAuth(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "ensure_metafields") {
    try {
      const result = await ensureXloxiCustomerMetafieldDefinitions(admin, shop);
      return {
        ok: result.errors.length === 0,
        intent,
        ...result,
        error:
          result.errors.length > 0
            ? toMerchantSafeError(result.errors[0])
            : null,
      };
    } catch (error) {
      return {
        ok: false,
        intent,
        error: toMerchantSafeError(
          error,
          "Could not create metafield definitions",
        ),
      };
    }
  }

  return { ok: false, intent, error: "unknown_intent" };
};

export default function FlowIntegrationPage() {
  const { stats, tags, metafields } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Metafield definitions ready");
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Shopify Flow Integration">
      <s-button
        slot="primary-action"
        onClick={() =>
          fetcher.submit({ intent: "ensure_metafields" }, { method: "POST" })
        }
      >
        Test integration (metafields)
      </s-button>

      <s-section heading="Required customer tags">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <code>{tags.request}</code> — Flow adds this to request a selection
          </s-paragraph>
          <s-paragraph>
            <code>{tags.pickPrefix}PRODUCT_HANDLE</code> — app writes one tag
            per selected product
          </s-paragraph>
          <s-paragraph>
            <code>{tags.ready}</code> — app adds last; Flow Workflow B triggers
            Messaging
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Required customer metafields">
        <s-paragraph>
          Namespace <code>{metafields.namespace}</code>
        </s-paragraph>
        <s-stack direction="block" gap="small-200">
          {metafields.keys.map((key) => (
            <s-paragraph key={key}>
              <code>
                {metafields.namespace}.{key}
              </code>
            </s-paragraph>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Workflow A — request selection">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>1. Trigger: Scheduled time</s-paragraph>
          <s-paragraph>
            2. Get customer data (max 100 per action) — filter marketing consent
            = SUBSCRIBED, due for selection
          </s-paragraph>
          <s-paragraph>
            3. Action: Add customer tag <code>{tags.request}</code>
          </s-paragraph>
          <s-paragraph>
            4. XLOXI receives customers/update webhook, selects products, writes
            pick tags + metafields, adds <code>{tags.ready}</code>, removes
            request
          </s-paragraph>
          <s-paragraph>
            For lists larger than 100, enable the optional app scheduler in
            Settings or chain multiple Flow “Get customer data” steps so
            subscribers are not starved.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Workflow B — send via Messaging">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>1. Trigger: Customer tags added</s-paragraph>
          <s-paragraph>
            2. Condition: newly added tags contain <code>{tags.ready}</code>
          </s-paragraph>
          <s-paragraph>3. Condition: marketing consent is SUBSCRIBED</s-paragraph>
          <s-paragraph>
            4. Action: Shopify Messaging — Send marketing email
          </s-paragraph>
          <s-paragraph>
            5. Action: Update customer metafield{" "}
            <code>
              {metafields.namespace}.{metafields.processedBatchId}
            </code>{" "}
            = pending batch id
          </s-paragraph>
          <s-paragraph>
            6. Action: Remove tag <code>{tags.ready}</code>
          </s-paragraph>
          <s-paragraph>
            Workflows are not created automatically — configure them manually in
            Shopify Admin → Flow. See docs/FLOW_SETUP.md.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Last acknowledgement">
        <s-paragraph>
          {stats.lastAcknowledgement
            ? `Batch ${stats.lastAcknowledgement.batchId} · ${formatDateTime(stats.lastAcknowledgement.at)}`
            : "No Flow acknowledgements yet."}
        </s-paragraph>
        <s-paragraph>
          Acknowledgement means Flow wrote processed_batch_id — it is not proof
          the email was delivered.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
