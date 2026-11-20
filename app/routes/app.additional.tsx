import type { LoaderFunctionArgs } from "react-router";
import { requireAdminAuth } from "../shopify/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Explicit shop-level auth even though parent /app also authenticates.
  await requireAdminAuth(request);
  return null;
};

export default function AdditionalPage() {
  return (
    <s-page heading="Additional page">
      <s-section heading="Multiple pages">
        <s-paragraph>
          Nested app routes remain protected by App Bridge session-token
          authentication and shop-scoped authorization helpers.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
