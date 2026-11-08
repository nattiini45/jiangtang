import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";

/**
 * `/inventory/stock` used to be the general-stock page. The inventory section
 * is one tabbed route now — stock renders at `/inventory?tab=stock` — so this
 * module only keeps the old URL alive as a redirect. The query string is
 * forwarded, because the stock filters (`location`, `vendor`, `q`,
 * `hideUnassigned`) live in the URL and are read by the tab with the same names.
 *
 * Note the route-resolution guard still pins this URL to this module (not to
 * the `/inventory/:id` equipment fallback) — that is what keeps the redirect
 * from ever being swallowed by the dynamic sibling.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  params.set("tab", "stock");
  throw redirect(`/inventory?${params.toString()}`);
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
