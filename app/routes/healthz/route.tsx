import type { Route } from "./+types/route";
import { readConfig } from "~/lib/config.server";
import { db } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";

/**
 * Liveness/readiness probe. Public (no auth) so the container platform or a load
 * balancer can poll it. Returns 200 + JSON when the DB is reachable, 503
 * otherwise. Cheap: a scalar `SELECT 1`, not a full connection checkout.
 *
 * The raw exception message is only sent in an explicit development run. Anywhere
 * else it is logged server-side instead, because it could leak connection strings
 * or internal hostnames to this unauthenticated caller.
 */
export async function loader(_: Route.LoaderArgs) {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "up" });
  } catch (e) {
    if (readConfig("NODE_ENV") !== "development") {
      logger.error({ err: e }, "healthz: DB check failed");
      return Response.json({ status: "degraded", db: "down" }, { status: 503 });
    }
    return Response.json(
      { status: "degraded", db: "down", error: (e as Error).message },
      { status: 503 },
    );
  }
}
