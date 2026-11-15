import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { getHome } from "~/domains/dashboard/home.queries.server";
import { Home } from "~/components/home/home";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { action as captureAction } from "~/routes/m.quick-entry/route";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "dashboard.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const params = new URL(request.url).searchParams;
  if (["roomId", "equipmentId", "type"].some((key) => params.has(key)))
    return redirect(`/m/quick-entry?${params}`);
  try {
    return { home: await getHome(actor.id) };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export async function action(args: Route.ActionArgs) {
  await requireUser(args.request);
  return captureAction({ request: args.request });
}

export default function MobileHome({ loaderData }: Route.ComponentProps) {
  return <Home data={loaderData.home} mobile />;
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
