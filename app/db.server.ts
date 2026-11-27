import { PrismaClient } from "./lib/prisma.server";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: InstanceType<typeof PrismaClient> | undefined;
}

/**
 * Reuse one PrismaClient per serverless isolate.
 * Production: pooled DATABASE_URL with connection_limit=1.
 * Local `shopify app dev`: prefer DIRECT_URL so catalog loaders are not starved
 * while a product-sync tick holds the single pooler connection.
 */
function resolveDatasourceUrl(): string | undefined {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev && process.env.DIRECT_URL?.trim()) {
    return process.env.DIRECT_URL.trim();
  }
  return process.env.DATABASE_URL?.trim() || undefined;
}

const datasourceUrl = resolveDatasourceUrl();

const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(datasourceUrl
      ? { datasources: { db: { url: datasourceUrl } } }
      : {}),
  });

global.prismaGlobal = prisma;

export default prisma;

// Vite SSR HMR: disconnect so the next load uses a freshly required PrismaClient
// (after `prisma generate`, Node's require cache can otherwise keep a stale DMMF).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void global.prismaGlobal?.$disconnect();
    global.prismaGlobal = undefined;
  });
}
