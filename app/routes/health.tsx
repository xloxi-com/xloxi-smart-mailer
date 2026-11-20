/**
 * Liveness probe — no auth, no database.
 * Cloud Run / load balancers: GET /health
 */
export const loader = async () => {
  return Response.json(
    {
      status: "ok",
      service: "xloxi-smart-mailer",
      time: new Date().toISOString(),
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
};
