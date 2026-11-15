import type { Route } from "./+types/route";
import { requireRole, requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { getHome } from "~/domains/dashboard/home.queries.server";
import { Home } from "~/components/home/home";
import { loadDemoWorkspace } from "~/lib/demo-seed.server";
import { totalCreated, totalSkipped } from "../../../scripts/seed/workspace-seed";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "dashboard.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  try {
    return { home: await getHome(actor.id) };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  if (form.get("intent") !== "load-demo") return { error: t(locale, "err.unknownAction") };
  const admin = await requireRole(request, "ADMIN");
  const summary = await loadDemoWorkspace(admin);
  return { loaded: true, created: totalCreated(summary), skipped: totalSkipped(summary) };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  return <Home data={loaderData.home} />;
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
