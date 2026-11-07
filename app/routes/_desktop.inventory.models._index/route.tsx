import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";

/**
 * `/inventory/models` used to be the model-catalog page. The inventory section
 * is one tabbed route now — the catalog renders at `/inventory?tab=models` —
 * so this module only keeps the old URL alive as a redirect.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  throw redirect("/inventory?tab=models");
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
