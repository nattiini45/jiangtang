import { redirect } from "react-router";
import { roundTargets, listRounds } from "./rounds.queries.server";
import { startRound } from "./rounds.mutations.server";
import { startRoundSchema } from "./rounds.schema";
import { safeParse } from "~/lib/validation.server";
import type { AuditActor } from "~/lib/audit.server";
import { tr, currentLocale } from "~/i18n/request-locale.server";
import { formatDate } from "~/i18n/format";
import { ValidationError, toErrorResponse } from "~/lib/errors.server";

export async function roundIndexData() {
  const [rooms, rounds] = await Promise.all([roundTargets(), listRounds()]);
  return {
    rooms,
    rounds,
    defaultName: tr("functions.rounds.defaultName", {
      date: formatDate(currentLocale(), new Date()),
    }),
  };
}

export async function startRoundFromForm(request: Request, actor: AuditActor, mobile: boolean) {
  const form = await request.formData();
  const parsed = safeParse(startRoundSchema, {
    name: form.get("name"),
    roomIds: form.getAll("roomIds"),
  });
  if (!parsed.success) return { error: tr("functions.rounds.invalid") };
  try {
    const round = await startRound(actor, parsed.data);
    return redirect(`${mobile ? "/m" : ""}/rounds/${round.id}`);
  } catch (error) {
    if (error instanceof ValidationError) return { error: tr("functions.rounds.invalid") };
    throw toErrorResponse(error);
  }
}
