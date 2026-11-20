import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireAdminAuth } from "../shopify/auth.server";

/** Legacy email analytics → dashboard (no fake delivery stats). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return redirect("/app");
};
