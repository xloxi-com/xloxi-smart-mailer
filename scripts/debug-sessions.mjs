import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const p = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined,
);

try {
  const sessions = await p.session.findMany({
    where: { shop: { contains: "offrefy" } },
    select: {
      id: true,
      shop: true,
      isOnline: true,
      scope: true,
      expires: true,
      refreshTokenExpires: true,
      accessToken: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(
    JSON.stringify(
      sessions.map((s) => ({
        id: s.id,
        shop: s.shop,
        isOnline: s.isOnline,
        scope: s.scope,
        expires: s.expires,
        refreshTokenExpires: s.refreshTokenExpires,
        hasAccessToken: Boolean(s.accessToken),
        accessTokenLen: s.accessToken?.length ?? 0,
      })),
      null,
      2,
    ),
  );
} finally {
  await p.$disconnect();
}
