import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";

/**
 * `/capacity` used to be the workload-heatmap page. The heatmap is the
 * capacity tab of `/timesheet` now, so this module only keeps the old URL
 * alive as a redirect.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  throw redirect("/timesheet?tab=capacity");
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
