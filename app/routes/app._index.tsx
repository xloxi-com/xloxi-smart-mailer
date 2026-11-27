import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import { getFlowDashboardStats } from "../services/admin-flow-dashboard.server";
import { formatDateTime } from "../utils/admin-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, missingScopes } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  const stats = await getFlowDashboardStats(shopRow.id);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const scopeUpdateUrl = apiKey
    ? `https://${shop}/admin/oauth/install?client_id=${encodeURIComponent(apiKey)}`
    : null;
  return { shop, stats, missingScopes, scopeUpdateUrl };
};

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint ? <s-text color="subdued">{hint}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export default function DashboardPage() {
  const { shop, stats, missingScopes, scopeUpdateUrl } =
    useLoaderData<typeof loader>();
  const productSyncTone =
    stats.sync.productSync?.status === "FAILED"
      ? "critical"
      : stats.sync.productSync?.status === "SUCCEEDED"
        ? "success"
        : "info";

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" href="/app/flow" variant="primary">
        Flow integration
      </s-button>

      {missingScopes.length > 0 ? (
        <s-banner tone="warning" heading="App permissions need an update">
          Missing scopes: {missingScopes.join(", ")}. Open the install link to
          approve them, then reload this app.
          {scopeUpdateUrl ? (
            <>
              {" "}
              <s-link href={scopeUpdateUrl} target="_blank">
                Update permissions
              </s-link>
            </>
          ) : null}
        </s-banner>
      ) : null}

      <s-section heading="Overview">
        <s-paragraph>
          Random product selection engine for <code>{shop}</code>. Emails are
          sent only by Shopify Messaging — this app never delivers mail.
        </s-paragraph>
        <s-grid
          gridTemplateColumns="repeat(auto-fill, minmax(160px, 1fr))"
          gap="base"
        >
          <StatCard label="Total products" value={stats.totals.totalProducts} />
          <StatCard
            label="Eligible products"
            value={stats.totals.eligibleProducts}
          />
          <StatCard
            label="Total subscribers"
            value={stats.totals.totalSubscribers}
          />
          <StatCard
            label="Active subscribers"
            value={stats.totals.activeSubscribers}
          />
          <StatCard
            label="Products selected today"
            value={stats.totals.productsSelectedToday}
          />
          <StatCard
            label="Pending batches"
            value={stats.totals.pendingBatches}
          />
          <StatCard
            label="Flow-triggered batches"
            value={stats.totals.flowTriggered}
          />
          <StatCard
            label="Flow-acknowledged"
            value={stats.totals.flowAcknowledged}
          />
          <StatCard label="Failed batches" value={stats.totals.failedBatches} />
        </s-grid>
      </s-section>

      <s-section heading="Synchronization">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200">
            <s-badge tone={stats.sync.automationEnabled ? "success" : "caution"}>
              Automation {stats.sync.automationEnabled ? "on" : "off"}
            </s-badge>
            <s-badge tone={stats.sync.testMode ? "info" : "warning"}>
              Test mode {stats.sync.testMode ? "on" : "off"}
            </s-badge>
            <s-badge tone="info">shopify_messaging</s-badge>
          </s-stack>
          <s-paragraph>
            Last sync:{" "}
            <strong>{formatDateTime(stats.sync.lastSyncAt, "Never")}</strong>
          </s-paragraph>
          {stats.sync.productSync?.lastError ? (
            <s-banner tone="critical" heading="Product sync issue">
              {stats.sync.productSync.lastError}
            </s-banner>
          ) : null}
          <s-paragraph>
            Product sync:{" "}
            <s-badge tone={productSyncTone}>
              {stats.sync.productSync?.status ?? "None"}
            </s-badge>
            {stats.sync.productSync
              ? ` · updated ${formatDateTime(stats.sync.productSync.updatedAt)}`
              : ""}
          </s-paragraph>
          <s-paragraph>
            Customer sync:{" "}
            <s-badge
              tone={
                stats.sync.customerSync?.status === "FAILED"
                  ? "critical"
                  : stats.sync.customerSync?.status === "SUCCEEDED"
                    ? "success"
                    : "info"
              }
            >
              {stats.sync.customerSync?.status ?? "None"}
            </s-badge>
            {stats.sync.customerSync
              ? ` · updated ${formatDateTime(stats.sync.customerSync.updatedAt)}`
              : ""}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button href="/app/products" variant="secondary">
              Sync products
            </s-button>
            <s-button href="/app/subscribers" variant="secondary">
              Sync subscribers
            </s-button>
            <s-button href="/app/selection" variant="secondary">
              Random selection
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
