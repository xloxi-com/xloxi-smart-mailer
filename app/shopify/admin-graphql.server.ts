import {
  GraphqlQueryError,
  HttpResponseError,
  HttpThrottlingError,
} from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "../lib/logging.server";
import { ShopifyGraphqlError, ShopifySessionInvalidError } from "./errors.server";

export type AdminGraphqlClient = Pick<AdminApiContext, "graphql">;

export type GraphqlVariables = Record<string, unknown> | undefined;

export type AdminGraphqlOptions = {
  variables?: GraphqlVariables;
  /** Max attempts including the first try. Default 5. */
  maxAttempts?: number;
  /** Base delay ms for exponential backoff. Default 500. */
  baseDelayMs?: number;
  shop?: string;
  /**
   * Called when Shopify returns 401/403 style auth failures so callers can
   * delete offline sessions and force reinstall.
   */
  onUnauthorized?: (shop: string) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((err) => {
    if (!err || typeof err !== "object") return false;
    const e = err as { extensions?: { code?: string }; message?: string };
    const code = e.extensions?.code?.toUpperCase();
    if (code === "THROTTLED") return true;
    return typeof e.message === "string" && /throttl/i.test(e.message);
  });
}

function retryAfterMs(error: unknown, attempt: number, baseDelayMs: number): number {
  if (error instanceof HttpThrottlingError) {
    const seconds = error.response.retryAfter;
    if (typeof seconds === "number" && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(30_000, baseDelayMs * 2 ** (attempt - 1) + jitter);
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof HttpResponseError) {
    return error.response.code === 401 || error.response.code === 403;
  }
  if (error instanceof GraphqlQueryError) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 401 || status === 403) return true;
    const message = error.message?.toLowerCase() ?? "";
    return (
      message.includes("invalid api key") ||
      message.includes("access token") ||
      message.includes("unauthorized")
    );
  }
  return false;
}

/**
 * Execute Admin GraphQL with throttling-aware retries and auth-failure handling.
 * Uses only the official Admin GraphQL client — never REST.
 */
export async function adminGraphql<T = unknown>(
  admin: AdminGraphqlClient,
  query: string,
  options: AdminGraphqlOptions = {},
): Promise<{ data: T; extensions?: unknown }> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const shop = options.shop ?? "unknown";

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await admin.graphql(query, {
        variables: options.variables,
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          if (options.onUnauthorized && shop !== "unknown") {
            await options.onUnauthorized(shop);
          }
          throw new ShopifySessionInvalidError(
            shop,
            status === 401 ? "EXPIRED" : "UNAUTHORIZED",
          );
        }
        if (status === 429 || status >= 500) {
          throw new ShopifyGraphqlError(`HTTP ${status}`, {
            status,
            retriable: true,
          });
        }
        throw new ShopifyGraphqlError(`HTTP ${status}`, {
          status,
          retriable: false,
        });
      }

      const json = (await response.json()) as {
        data?: T;
        errors?: unknown;
        extensions?: unknown;
      };

      if (json.errors && isThrottlePayload(json)) {
        throw new ShopifyGraphqlError("GraphQL throttled", {
          status: 429,
          retriable: true,
        });
      }

      if (json.errors) {
        logger.warn("admin_graphql_user_or_query_errors", {
          shop,
          attempt,
          // Do not log full error payloads that may include PII fields.
          errorCount: Array.isArray(json.errors) ? json.errors.length : 1,
        });
        throw new ShopifyGraphqlError("GraphQL response contained errors", {
          retriable: false,
        });
      }

      return { data: json.data as T, extensions: json.extensions };
    } catch (error) {
      lastError = error;

      if (error instanceof ShopifySessionInvalidError) {
        throw error;
      }

      if (isUnauthorized(error)) {
        if (options.onUnauthorized && shop !== "unknown") {
          await options.onUnauthorized(shop);
        }
        throw new ShopifySessionInvalidError(shop, "REVOKED");
      }

      const retriable =
        error instanceof ShopifyGraphqlError
          ? error.retriable
          : error instanceof HttpThrottlingError ||
            error instanceof HttpResponseError
            ? error.response.code === 429 || error.response.code >= 500
            : false;

      if (!retriable || attempt >= maxAttempts) {
        logger.error("admin_graphql_failed", {
          shop,
          attempt,
          retriable,
          name: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }

      const delay = retryAfterMs(error, attempt, baseDelayMs);
      logger.warn("admin_graphql_retry", { shop, attempt, delayMs: delay });
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ShopifyGraphqlError("GraphQL request failed");
}
