import { PrismaClient } from "./lib/prisma.server";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: InstanceType<typeof PrismaClient> | undefined;
}

/**
 * Reuse one PrismaClient per serverless isolate.
 * Pair with DATABASE_URL `connection_limit=1` (Supabase transaction pooler).
 */
const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
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
