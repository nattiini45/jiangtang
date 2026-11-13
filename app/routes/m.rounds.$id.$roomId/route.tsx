import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getRound } from "~/domains/functions/rounds.queries.server";
import { getFunctionStates } from "~/domains/functions/functions.queries.server";
import { recordCheck, finishEmptyRoundRoom } from "~/domains/functions/rounds.mutations.server";
import { recordCheckSchema } from "~/domains/functions/rounds.schema";
import { parseInput } from "~/lib/validation.server";
import { NotFoundError, ValidationError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { RoomCheckPage } from "~/components/rooms/room-check";
export { roundPageMeta as meta } from "~/components/rooms/round-pages";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const round = await getRound(params.id);
  const target = round?.rooms.find((row) => row.roomId === params.roomId);
  if (!round || !target) throw toErrorResponse(new NotFoundError());
  const functions = (await getFunctionStates({ roomIds: [params.roomId] })).filter(
    (row) =>
      row.expected ||
      row.hasCarrier ||
      row.faults.some((fault) => fault.functionId === row.functionId),
  );
  return {
    round,
    room: target.room,
    functions,
    checks: round.checks.filter((row) => row.roomId === params.roomId),
  };
}
export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  try {
    const form = await request.formData();
    if (form.get("intent") === "finishEmpty") {
      await finishEmptyRoundRoom(actor, params.id, params.roomId);
      return { finished: true };
    }
    const input = parseInput(recordCheckSchema, {
      roomId: params.roomId,
      roundId: params.id,
      functionId: form.get("functionId"),
      result: form.get("result"),
      note: form.get("note") ?? undefined,
      resolution: form.get("resolution") ?? undefined,
      resolveFaults: form.getAll("resolveFaults"),
      restoreDevices: form.getAll("restoreDevices"),
    });
    return { check: await recordCheck(actor, input) };
  } catch (error) {
    if (error instanceof ValidationError) return { error: tr("functions.rounds.invalid") };
    throw toErrorResponse(error);
  }
}
export default function CheckPage({ loaderData }: Route.ComponentProps) {
  return <RoomCheckPage {...loaderData} />;
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
