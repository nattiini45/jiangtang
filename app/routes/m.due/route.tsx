import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { getFunctionStates } from "~/domains/functions/functions.queries.server";
import { getHomeDue } from "~/domains/dashboard/home.queries.server";
import { DuePage } from "~/components/home/due";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: `${t(metaLocale(matches), "dashboard.home.due.title")} · Jiangtang` }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    const now = new Date();
    return await getHomeDue(await getFunctionStates({ now }), now);
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function Due({ loaderData }: Route.ComponentProps) {
  return <DuePage due={loaderData} mobile />;
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
