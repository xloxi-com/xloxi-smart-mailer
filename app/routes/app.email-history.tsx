import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireAdminAuth } from "../shopify/auth.server";

/** Legacy email history → selection history. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return redirect("/app/selection-history");
};
