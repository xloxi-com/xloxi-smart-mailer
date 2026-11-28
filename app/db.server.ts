import { PrismaClient } from "./lib/prisma.server";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: InstanceType<typeof PrismaClient> | undefined;
}

/**
 * Reuse one PrismaClient per serverless isolate.
 *
 * Production MUST use pooled DATABASE_URL (IPv4 pooler). DIRECT_URL (port 5432)
 * often fails on Vercel (IPv6-only) and crashes the embedded app with
 * "Application Error". Local/dev may use DIRECT_URL to avoid pool starvation
 * during long sync ticks.
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
