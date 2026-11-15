import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getRound } from "~/domains/functions/rounds.queries.server";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { RoundProgress } from "~/components/rooms/round-pages";
export { roundPageMeta as meta } from "~/components/rooms/round-pages";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const round = await getRound(params.id);
  if (!round) throw toErrorResponse(new NotFoundError());
  return { round };
}
export default function Progress({ loaderData }: Route.ComponentProps) {
  return <RoundProgress round={loaderData.round} />;
}
export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
