import { useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";
import {
  buildMessagingLiquidTemplate,
  buildMessagingSetupGuide,
} from "../templates/messaging-liquid.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return {
    liquid: buildMessagingLiquidTemplate({ includeOpenTracking: true }),
    guide: buildMessagingSetupGuide(),
  };
};

export default function MessagingPage() {
  const { liquid, guide } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [copied, setCopied] = useState(false);

  return (
    <s-page heading="Shopify Messaging">
      <s-button
        slot="primary-action"
        onClick={async () => {
          await navigator.clipboard.writeText(liquid);
          setCopied(true);
          shopify.toast.show("Liquid code copied");
        }}
      >
        {copied ? "Copied" : "Copy Liquid Code"}
      </s-button>

      <s-section heading="Custom Liquid template">
        <s-paragraph>
          Paste this into the Shopify Messaging email editor. XLOXI does not
          send email — Messaging renders products from{" "}
          <code>xloxi-pick:</code> customer tags.
        </s-paragraph>
        <s-text-area
          label="Liquid code"
          labelAccessibilityVisibility="exclusive"
          readOnly
          rows={18}
          value={liquid}
        />
      </s-section>

      <s-section heading="Email layout preview">
        <s-paragraph>
          Responsive 2-column grid · product image · title · price · SHOP NOW ·
          unsubscribe link · optional open tracking.
        </s-paragraph>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          {[1, 2, 3, 4].map((n) => (
            <s-box
              key={n}
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200">
                <s-thumbnail alt={`Product ${n}`} size="large" />
                <s-heading>Product {n}</s-heading>
                <s-text color="subdued">$00.00</s-text>
                <s-button variant="primary">SHOP NOW</s-button>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Setup guide">
        <s-unordered-list>
          {guide.split("\n").map((line) => (
            <s-list-item key={line}>{line.replace(/^\d+\.\s*/, "")}</s-list-item>
          ))}
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
