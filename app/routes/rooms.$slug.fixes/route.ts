import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomBySlug } from "~/domains/rooms/rooms.queries.server";
import { moveKnownIssues, moveKnownIssuesSchema } from "~/domains/rooms/rooms.known-fixes.server";
import { editKnownFix, knownFixSchema } from "~/domains/tickets/tickets.known-fixes.server";
import { emitChange } from "~/lib/realtime/emit.server";

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  try {
    const room = await getRoomBySlug(params.slug);
    if (!room) throw new NotFoundError(tr("err.room.notFound"));
    const form = await request.clone().formData();
    let ticketId: string | undefined;
    if (form.get("intent") === "move") {
      const result = await safeParseForm(request, moveKnownIssuesSchema);
      if (!result.success) return { error: Object.values(result.fieldErrors).flat().join(" · ") };
      ticketId = (await moveKnownIssues(actor, room.id, result.data))?.id;
    } else {
      const result = await safeParseForm(request, knownFixSchema);
      if (!result.success) return { error: Object.values(result.fieldErrors).flat().join(" · ") };
      ticketId = (await editKnownFix(actor, room.id, result.data)).id;
    }
    if (ticketId) await emitChange({ entityType: "ticket", id: ticketId, op: "updated" });
    await emitChange({ entityType: "room", id: room.id, op: "updated" });
    return { ok: true };
  } catch (error) {
    if (error instanceof ValidationError)
      return {
        error: [...error.formErrors, ...Object.values(error.fieldErrors).flat()].join(" · "),
      };
    throw toErrorResponse(error);
  }
}
