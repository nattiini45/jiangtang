import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";

/**
 * `/campuses` used to be the campus/building CRUD page. The nav no longer has a
 * Campuses entry — the CRUD lives in `/rooms?manage=campuses` — so this module
 * only keeps the old URL alive as a redirect.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  throw redirect("/rooms?manage=campuses");
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
