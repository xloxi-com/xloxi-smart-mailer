import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";
import { ensureShop } from "../services/shop.server";
import {
  getConnectionStatus,
  saveAdminSettings,
  settingsToSettingsForm,
} from "../services/admin-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  return {
    shop,
    form: settingsToSettingsForm(shopRow, shopRow.automationSettings),
    connection: getConnectionStatus(),
    automation: {
      enabled: shopRow.automationSettings?.automationEnabled ?? false,
      testMode: shopRow.automationSettings?.testMode ?? true,
      intervalDays: shopRow.automationSettings?.intervalDays ?? 3,
      productsPerEmail: shopRow.automationSettings?.productsPerEmail ?? 6,
      inStockOnly: shopRow.automationSettings?.inStockOnly !== false,
      appSchedulerEnabled:
        shopRow.automationSettings?.appSchedulerEnabled ?? false,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent !== "save") {
    return { ok: false, error: "unknown_intent" };
  }
  if (formData.get("confirmSave") !== "yes") {
    return {
      ok: false,
      error: "Confirm saving settings before continuing.",
    };
  }

  const { shop: updatedShop, settings } = await saveAdminSettings(
    shop,
    formData,
  );
  return {
    ok: true,
    form: settingsToSettingsForm(updatedShop, settings),
  };
};

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const form =
    actionData && "form" in actionData && actionData.form
      ? actionData.form
      : loaderData.form;
  const { connection, automation } = loaderData;
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save";

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Settings">
      <s-section heading="Integration status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200">
            <s-badge tone="info">Shopify Messaging only</s-badge>
            <s-badge tone="success">App email sending disabled</s-badge>
            <s-badge tone={automation.enabled ? "success" : "caution"}>
              Automation {automation.enabled ? "on" : "off"}
            </s-badge>
            <s-badge tone={automation.testMode ? "info" : "warning"}>
              Test mode {automation.testMode ? "on" : "off"}
            </s-badge>
          </s-stack>
          <s-paragraph>
            Interval: <strong>{automation.intervalDays}d</strong>
            {" · "}
            Products/email: <strong>{automation.productsPerEmail}</strong>
            {" · "}
            Database:{" "}
            <strong>
              {connection.databaseConfigured ? "configured" : "missing"}
            </strong>
          </s-paragraph>
          <s-paragraph>
            Product exclusions and collection GIDs are managed on{" "}
            <s-link href="/app/products">Products</s-link>. Selection rules are
            on <s-link href="/app/automation">Automation</s-link>.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Shop preferences">
        <Form method="post" key={JSON.stringify(form)}>
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="emailProviderLabel" value="shopify_messaging" />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Timezone"
              name="timezone"
              defaultValue={form.timezone}
              placeholder="UTC"
            />
            <s-email-field
              label="Contact / reply-to (optional)"
              name="replyTo"
              defaultValue={form.replyTo}
            />
            <s-text-field
              label="From name (Messaging branding reference only)"
              name="fromName"
              defaultValue={form.fromName}
            />
            <s-number-field
              label="Sync interval hint (minutes)"
              name="syncIntervalMinutes"
              min={15}
              max={10080}
              defaultValue={String(form.syncIntervalMinutes)}
            />
            <s-number-field
              label="Data retention (days)"
              name="dataRetentionDays"
              min={30}
              max={2555}
              defaultValue={String(form.dataRetentionDays)}
            />
            <s-checkbox
              name="confirmSave"
              value="yes"
              required
              label="I confirm these settings should be saved"
            />
            {actionData && "error" in actionData && actionData.error ? (
              <s-banner tone="critical" heading="Could not save">
                {actionData.error}
              </s-banner>
            ) : null}
            <s-button type="submit" variant="primary" {...(isSaving ? { loading: true } : {})}>
              Save settings
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
