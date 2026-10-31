import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import {
  findRoomConflicts,
  findEquipmentConflicts,
  type RoomConflict,
  type EquipmentConflict,
} from "~/domains/events/events.availability.server";

/**
 * Resource route backing the pre-save conflict picker. The event
 * detail's add-forms poll this with `useFetcher` as the user picks a room or
 * pooled unit + window; the result renders an inline conflict badge BEFORE the
 * submit. The DB GiST EXCLUDE remains the authority; this is the accelerator.
 *
 * Query params: kind=room|equipment, id, startsAt, endsAt (Berlin datetime-local),
 * and optional exclude (booking/allocation id being edited).
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request); // auth-gated; same surface as the event page
  try {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    const id = url.searchParams.get("id");
    const startsRaw = url.searchParams.get("startsAt");
    const endsRaw = url.searchParams.get("endsAt");
    const exclude = url.searchParams.get("exclude") ?? undefined;

    if (!id || !startsRaw || !endsRaw) {
      return Response.json({ conflicts: [] });
    }
    const startsAt = berlinLocalToUtc(startsRaw);
    const endsAt = berlinLocalToUtc(endsRaw);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
      return Response.json({ conflicts: [] });
    }

    let conflicts: RoomConflict[] | EquipmentConflict[] = [];
    if (kind === "room") {
      conflicts = await findRoomConflicts(id, startsAt, endsAt, exclude);
    } else if (kind === "equipment") {
      conflicts = await findEquipmentConflicts(id, startsAt, endsAt, exclude);
    }
    return Response.json({ conflicts });
  } catch (e) {
    throw toErrorResponse(e);
  }
}
