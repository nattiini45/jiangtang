import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { listHomeChanges } from "~/domains/dashboard/home-activity.queries.server";
import { HomeChanges } from "~/components/home/changes";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: `${t(metaLocale(matches), "dashboard.home.activity.title")} · Jiangtang` }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    return await listHomeChanges(new URL(request.url).searchParams.get("cursor") ?? undefined);
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function Changes({ loaderData }: Route.ComponentProps) {
  return <HomeChanges data={loaderData} mobile />;
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
