import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { parseInput } from "~/lib/validation.server";
import { functionStateSchema } from "~/domains/functions/rounds.schema";
import { setFunctionState, clearFunctionState } from "~/domains/functions/rounds.mutations.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { ValidationError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  try {
    const form = await request.formData();
    const roomId = String(form.get("roomId") ?? "");
    const functionId = String(form.get("functionId") ?? "");
    const until = String(form.get("until") ?? "");
    if (until && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(until))
      throw new ValidationError({ until: [] });
    if (form.get("intent") === "clear") await clearFunctionState(actor, roomId, functionId);
    else {
      const input = parseInput(functionStateSchema, {
        roomId,
        functionId,
        state: form.get("state"),
        reason: form.get("reason"),
        until: until ? berlinLocalToUtc(until) : undefined,
      });
      await setFunctionState(actor, input);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof ValidationError) return { error: tr("functions.rounds.invalid") };
    throw toErrorResponse(error);
  }
}
