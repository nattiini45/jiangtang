import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { PlansPage } from "~/components/plans/plans";
import { plansAction, plansPageData } from "~/domains/plans/plans.routes.server";
import { toErrorResponse } from "~/lib/errors.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: `${t(metaLocale(matches), "plans.title")} · Jiangtang` }];
}
export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  try {
    return await plansPageData(
      actor,
      params.id,
      new URL(request.url).searchParams.get("device") ?? undefined,
    );
  } catch (error) {
    throw toErrorResponse(error);
  }
}
export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  return plansAction(request, actor, params.id, true);
}
export default function Page({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <PlansPage
      page={loaderData}
      error={actionData && "error" in actionData ? actionData.error : undefined}
      saved={actionData && "saved" in actionData ? actionData.saved : undefined}
      mobile
    />
  );
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
