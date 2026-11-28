import { PrismaClient } from "./lib/prisma.server";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: InstanceType<typeof PrismaClient> | undefined;
}

/**
 * Reuse one PrismaClient per serverless isolate.
 *
 * Prefer DIRECT_URL whenever set. The transaction-pooler DATABASE_URL with
 * `connection_limit=1` starves concurrent Admin requests during product sync
 * (pool timeout → "The operation timed out" / Catalog stuck empty).
 */
function resolveDatasourceUrl(): string | undefined {
  const direct = process.env.DIRECT_URL?.trim();
  if (direct) return direct;
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
