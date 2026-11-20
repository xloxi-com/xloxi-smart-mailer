import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminAuth } from "../shopify/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminAuth(request);
  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
