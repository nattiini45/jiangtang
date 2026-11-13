import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getFunctionList } from "~/domains/functions/functions.list.server";
import { FunctionList } from "~/components/rooms/function-list";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "functions.list.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return getFunctionList(request);
}

export default function Functions({ loaderData }: Route.ComponentProps) {
  return <FunctionList {...loaderData} />;
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
