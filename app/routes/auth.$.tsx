import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

/**
 * OAuth / token-exchange bounce route.
 * authenticate.admin() usually throws a redirect Response. If it returns
 * (session already valid), send the merchant into the embedded app instead of
 * rendering JSON `null` (resource route with no UI).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  throw redirect(shop ? `/app?${url.searchParams.toString()}` : "/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
