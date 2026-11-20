import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireAdminAuth } from "../shopify/auth.server";

/** Legacy route — templates live at /app/email-templates. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return redirect("/app/email-templates");
};
