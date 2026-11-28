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
  saveAutomationSettings,
  settingsToAutomationForm,
} from "../services/admin-automation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const shopRow = await ensureShop(shop);
  return {
    shop,
    form: settingsToAutomationForm(shopRow.automationSettings),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdminAuth(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "save") {
    if (formData.get("confirmSave") !== "yes") {
      return {
        ok: false,
        error: "Confirm saving automation settings before continuing.",
      };
    }
    const settings = await saveAutomationSettings(shop, formData);
    return {
      ok: true,
      form: settingsToAutomationForm(settings),
    };
  }

  return { ok: false, error: "unknown_intent" };
};

export default function AutomationPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const form =
    actionData && "form" in actionData && actionData.form
      ? actionData.form
      : loaderData.form;
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save";

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      shopify.toast.show("Automation settings saved");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Automation">
      <s-section heading="Selection rules">
        <s-paragraph>
          XLOXI selects random products and writes customer tags/metafields for
          Shopify Flow. Shopify Messaging sends the email. Live automation stays
          off by default — keep test mode on until end-to-end verification.
        </s-paragraph>
        <Form method="post" key={JSON.stringify(form)}>
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="base">
            <s-checkbox
              name="automationEnabled"
              label="Enable automation (Flow request processing)"
              defaultChecked={form.automationEnabled}
            />
            <s-checkbox
              name="testMode"
              label="Test mode (recommended)"
              defaultChecked={form.testMode}
            />
            <s-checkbox
              name="appSchedulerEnabled"
              label="Optional app scheduler (tags due subscribers with xloxi-request)"
              defaultChecked={form.appSchedulerEnabled}
            />
            <s-paragraph>
              Cadence is fixed to Monday and Thursday (UTC). Interval days only
              sizes the first-send stagger window — it does not skip Mon/Thu
              slots.
            </s-paragraph>
            <s-number-field
              label="Stagger window (days, first send only)"
              name="intervalDays"
              min={1}
              max={30}
              required
              defaultValue={String(form.intervalDays)}
            />
            <s-number-field
              label="Products per email (default 4)"
              name="productsPerEmail"
              min={1}
              max={12}
              required
              defaultValue={String(form.productsPerEmail)}
            />
            <s-checkbox
              name="randomSelection"
              label="Random selection"
              defaultChecked={form.randomSelection}
            />
            <s-checkbox
              name="inStockOnly"
              label="In-stock only"
              defaultChecked={form.inStockOnly}
            />
            <s-checkbox
              name="preventDuplicates"
              label="Prevent duplicates within a cycle"
              defaultChecked={form.preventDuplicates}
            />
            <s-checkbox
              name="autoResetCycle"
              label="Automatic cycle reset"
              defaultChecked={form.autoResetCycle}
            />
            <s-number-field
              label="Max Flow tags per app-scheduler run"
              name="maxEmailsPerRun"
              min={1}
              max={100}
              required
              defaultValue={String(Math.min(100, form.maxEmailsPerRun))}
            />
            <s-number-field
              label="Soft hourly tag cap"
              name="maxEmailsPerHour"
              min={1}
              max={5000}
              required
              defaultValue={String(form.maxEmailsPerHour)}
            />
            <s-number-field
              label="Soft daily tag cap"
              name="maxEmailsPerDay"
              min={1}
              max={10000}
              required
              defaultValue={String(form.maxEmailsPerDay)}
            />
            <s-checkbox
              name="confirmSave"
              value="yes"
              required
              label="I confirm these automation changes should be saved"
            />
            {actionData && "error" in actionData && actionData.error ? (
              <s-banner tone="critical" heading="Could not save">
                {actionData.error}
              </s-banner>
            ) : null}
            <s-button type="submit" variant="primary" {...(isSaving ? { loading: true } : {})}>
              Save automation settings
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="How selection works">
        <s-paragraph>
          Eligible Online Store products (active, published, in-stock) are
          chosen without repeating within a subscriber&apos;s cycle. When the
          pool is exhausted, a new cycle begins. Product exclusions are managed
          on the Products page.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
