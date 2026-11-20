/**
 * Admin GraphQL: customer tags + xloxi metafields (Shopify Basic compatible).
 */
import type { AdminGraphqlClient } from "../shopify/admin-graphql.server";
import { adminGraphql } from "../shopify/admin-graphql.server";
import {
  XLOXI_METAFIELD_KEYS,
  XLOXI_METAFIELD_NAMESPACE,
} from "./flow-tags.server";

export type CustomerFlowSnapshot = {
  id: string;
  tags: string[];
  marketingState: string | null;
  metafields: {
    pendingBatchId: string | null;
    processedBatchId: string | null;
    lastProcessedAt: string | null;
    nextSelectionAt: string | null;
  };
};

const METAFIELD_FRAGMENT = `
  pending: metafield(namespace: "${XLOXI_METAFIELD_NAMESPACE}", key: "${XLOXI_METAFIELD_KEYS.pendingBatchId}") { value }
  processed: metafield(namespace: "${XLOXI_METAFIELD_NAMESPACE}", key: "${XLOXI_METAFIELD_KEYS.processedBatchId}") { value }
  lastProcessed: metafield(namespace: "${XLOXI_METAFIELD_NAMESPACE}", key: "${XLOXI_METAFIELD_KEYS.lastProcessedAt}") { value }
  nextSelection: metafield(namespace: "${XLOXI_METAFIELD_NAMESPACE}", key: "${XLOXI_METAFIELD_KEYS.nextSelectionAt}") { value }
`;

export async function fetchCustomerFlowSnapshot(
  client: AdminGraphqlClient,
  shop: string,
  customerGid: string,
): Promise<CustomerFlowSnapshot | null> {
  const { data } = await adminGraphql<{
    customer: {
      id: string;
      tags: string[];
      emailMarketingConsent: { marketingState: string } | null;
      pending: { value: string } | null;
      processed: { value: string } | null;
      lastProcessed: { value: string } | null;
      nextSelection: { value: string } | null;
    } | null;
  }>(
    client,
    `#graphql
      query XloxiCustomerFlowSnapshot($id: ID!) {
        customer(id: $id) {
          id
          tags
          emailMarketingConsent { marketingState }
          ${METAFIELD_FRAGMENT}
        }
      }`,
    { shop, variables: { id: customerGid } },
  );

  if (!data.customer) return null;

  return {
    id: data.customer.id,
    tags: data.customer.tags ?? [],
    marketingState: data.customer.emailMarketingConsent?.marketingState ?? null,
    metafields: {
      pendingBatchId: data.customer.pending?.value ?? null,
      processedBatchId: data.customer.processed?.value ?? null,
      lastProcessedAt: data.customer.lastProcessed?.value ?? null,
      nextSelectionAt: data.customer.nextSelection?.value ?? null,
    },
  };
}

export async function tagsAdd(
  client: AdminGraphqlClient,
  shop: string,
  customerGid: string,
  tags: string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const { data } = await adminGraphql<{
    tagsAdd: { userErrors: Array<{ message: string }> };
  }>(
    client,
    `#graphql
      mutation XloxiTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { shop, variables: { id: customerGid, tags } },
  );
  const errors = data.tagsAdd.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; ") || "tagsAdd_failed");
  }
  return tags;
}

export async function tagsRemove(
  client: AdminGraphqlClient,
  shop: string,
  customerGid: string,
  tags: string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const { data } = await adminGraphql<{
    tagsRemove: { userErrors: Array<{ message: string }> };
  }>(
    client,
    `#graphql
      mutation XloxiTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
    { shop, variables: { id: customerGid, tags } },
  );
  const errors = data.tagsRemove.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => e.message).join("; ") || "tagsRemove_failed",
    );
  }
  return tags;
}

export type XloxiMetafieldWrite = {
  key: string;
  type: "single_line_text_field" | "date_time";
  value: string;
};

export async function setCustomerXloxiMetafields(
  client: AdminGraphqlClient,
  shop: string,
  customerGid: string,
  fields: XloxiMetafieldWrite[],
): Promise<void> {
  if (fields.length === 0) return;

  const { data } = await adminGraphql<{
    metafieldsSet: {
      userErrors: Array<{ message: string; code?: string }>;
    };
  }>(
    client,
    `#graphql
      mutation XloxiMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { message code }
        }
      }`,
    {
      shop,
      variables: {
        metafields: fields.map((f) => ({
          ownerId: customerGid,
          namespace: XLOXI_METAFIELD_NAMESPACE,
          key: f.key,
          type: f.type,
          value: f.value,
        })),
      },
    },
  );

  const errors = data.metafieldsSet.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => e.message).join("; ") || "metafieldsSet_failed",
    );
  }
}

/**
 * Ensure app-owned customer metafield definitions exist (idempotent).
 */
export async function ensureXloxiCustomerMetafieldDefinitions(
  client: AdminGraphqlClient,
  shop: string,
): Promise<{ created: number; existing: number; errors: string[] }> {
  const definitions: Array<{
    key: string;
    name: string;
    type: string;
  }> = [
    {
      key: XLOXI_METAFIELD_KEYS.pendingBatchId,
      name: "XLOXI Pending Batch ID",
      type: "single_line_text_field",
    },
    {
      key: XLOXI_METAFIELD_KEYS.processedBatchId,
      name: "XLOXI Processed Batch ID",
      type: "single_line_text_field",
    },
    {
      key: XLOXI_METAFIELD_KEYS.lastProcessedAt,
      name: "XLOXI Last Processed At",
      type: "date_time",
    },
    {
      key: XLOXI_METAFIELD_KEYS.nextSelectionAt,
      name: "XLOXI Next Selection At",
      type: "date_time",
    },
  ];

  let created = 0;
  let existing = 0;
  const errors: string[] = [];

  for (const def of definitions) {
    const { data } = await adminGraphql<{
      metafieldDefinitionCreate: {
        createdDefinition: { id: string } | null;
        userErrors: Array<{ message: string; code?: string }>;
      };
    }>(
      client,
      `#graphql
        mutation XloxiMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { message code }
          }
        }`,
      {
        shop,
        variables: {
          definition: {
            name: def.name,
            namespace: XLOXI_METAFIELD_NAMESPACE,
            key: def.key,
            type: def.type,
            ownerType: "CUSTOMER",
            pin: true,
          },
        },
      },
    );

    const userErrors = data.metafieldDefinitionCreate.userErrors ?? [];
    if (data.metafieldDefinitionCreate.createdDefinition) {
      created += 1;
      continue;
    }
    const already =
      userErrors.some((e) =>
        /taken|already|exists|duplicate/i.test(e.message),
      ) ||
      userErrors.some((e) => e.code === "TAKEN");
    if (already || userErrors.length === 0) {
      existing += 1;
    } else {
      errors.push(
        ...userErrors.map((e) => `${def.key}: ${e.message}`),
      );
    }
  }

  return { created, existing, errors };
}
