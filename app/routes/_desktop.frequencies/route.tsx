import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";

/**
 * `/frequencies` used to be the frequency-coordination page. It is the
 * frequencies tab of `/inventory` now, so this module only keeps the old URL
 * alive as a redirect.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  throw redirect("/inventory?tab=frequencies");
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
