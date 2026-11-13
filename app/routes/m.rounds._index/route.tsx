import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { RoundIndex } from "~/components/rooms/round-pages";
export { roundPageMeta as meta } from "~/components/rooms/round-pages";
import { roundIndexData, startRoundFromForm } from "~/domains/functions/rounds.routes.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return roundIndexData();
}
export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  return startRoundFromForm(request, actor, true);
}
export default function Rounds({ loaderData, actionData }: Route.ComponentProps) {
  return <RoundIndex {...loaderData} error={actionData?.error} mobile />;
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
