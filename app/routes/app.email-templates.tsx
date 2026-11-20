import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireAdminAuth } from "../shopify/auth.server";

/** Legacy email templates → Shopify Messaging Liquid page. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return redirect("/app/messaging");
};
