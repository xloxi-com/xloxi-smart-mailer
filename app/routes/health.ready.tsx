/**
 * Readiness probe — verifies PostgreSQL connectivity.
 * Cloud Run startup/readiness: GET /health/ready
 * Does not expose connection strings or query results.
 */
import prisma from "../db.server";
import { logger } from "../lib/logging.server";

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      {
        status: "ready",
        database: "ok",
        time: new Date().toISOString(),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    logger.error("health_ready_failed", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message.slice(0, 200) : "db_error",
    });
    return Response.json(
      {
        status: "not_ready",
        database: "error",
        time: new Date().toISOString(),
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }
};
