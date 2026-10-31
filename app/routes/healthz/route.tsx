import type { Route } from "./+types/route";
import { db } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";

/**
 * Liveness/readiness probe. Public (no auth) so Coolify / a load
 * balancer can poll it. Returns 200 + JSON when the DB is reachable, 503
 * otherwise. Cheap: a scalar `SELECT 1`, not a full connection checkout.
 *
 * the raw exception message is never sent to this unauthenticated caller in
 * production (it could leak connection strings / internal hostnames) — it's
 * logged server-side instead. Non-production keeps the detailed message for DX.
 */
export async function loader(_: Route.LoaderArgs) {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "up" });
  } catch (e) {
    if (process.env.NODE_ENV === "production") {
      logger.error({ err: e }, "healthz: DB check failed");
      return Response.json({ status: "degraded", db: "down" }, { status: 503 });
    }
    return Response.json(
      { status: "degraded", db: "down", error: (e as Error).message },
      { status: 503 },
    );
  }
}
