import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getDeviceReadings } from "~/domains/readings/readings.queries.server";
import { readingFromForm } from "~/domains/readings/readings.routes.server";
import { ReadingsPage } from "~/components/inventory/readings";
import { toErrorResponse } from "~/lib/errors.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ data, matches }: Route.MetaArgs) {
  return [
    {
      title: `${data?.device.name ?? ""} · ${t(metaLocale(matches), "readings.title")} · Jiangtang`,
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    return await getDeviceReadings(params.id, new URL(request.url).searchParams.has("history"));
  } catch (error) {
    throw toErrorResponse(error);
  }
}
export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  return readingFromForm(await request.formData(), actor, params.id);
}
export default function Page({ loaderData }: Route.ComponentProps) {
  return <ReadingsPage {...loaderData} />;
}
export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
