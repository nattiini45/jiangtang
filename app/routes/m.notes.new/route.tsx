import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { noteCreateSchema } from "~/domains/notes/notes.schema";
import { createNote } from "~/domains/notes/notes.mutations.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { CAPTURE_HEADER } from "~/lib/pwa/offline-queue";
import { assertCaptureOwner } from "~/lib/pwa/capture-owner.server";
import { CaptureQueueStatus, useCaptureSubmit } from "~/components/mobile/capture-form";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { MobileRouteErrorBoundary as RouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";

/**
 * Mobile note capture — title, body, comma-separated tags. Same
 * offline-queue shape as `/m/tasks/new`: the client mints `clientId`, the
 * note gets it as its id, replay is idempotent by construction.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "mobile.meta.noteNew") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return {};
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  assertCaptureOwner(request, actor);
  const locale = resolveLocale(request);
  const wantsJson = request.headers.get(CAPTURE_HEADER) === "1";
  const obj = formDataToObject(await request.formData());
  const { clientId, tags, ...rest } = obj;
  const parsed = safeParse(
    noteCreateSchema,
    {
      ...rest,
      // The mobile form sends one comma-separated field; the schema's tagsField
      // accepts an array — split here like the desktop form does per input.
      tags:
        typeof tags === "string"
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : tags,
    },
    locale,
  );
  try {
    if (!parsed.success) {
      throw new ValidationError(parsed.fieldErrors, parsed.formErrors);
    }
    const note = await createNote(
      actor,
      parsed.data,
      typeof clientId === "string" && clientId !== "" ? clientId : undefined,
    );
    await emitChange({ entityType: "note", id: note.id, op: "created" });
    if (wantsJson) return Response.json({ id: note.id });
    return { ok: true, id: note.id };
  } catch (e) {
    if (wantsJson && e instanceof ValidationError) {
      const msg = [...e.formErrors, ...Object.values(e.fieldErrors).flat()].join(" · ");
      return Response.json({ error: msg || t(locale, "err.invalidInput") }, { status: 400 });
    }
    throw toErrorResponse(e);
  }
}

export default function MobileNoteNew() {
  const tr = useT();
  const { state, error, submit } = useCaptureSubmit("/m/notes/new");
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-col gap-1">
        <Link to="/m" className="text-muted-foreground flex min-h-11 items-center text-sm">
          {tr("mobile.noteNew.back")}
        </Link>
        <h1 className="text-lg font-semibold">{tr("mobile.noteNew.title")}</h1>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          // React clears currentTarget once the handler yields, so keep the form.
          const form = e.currentTarget;
          const result = await submit(form);
          // A queued capture is stored and listed below; a filled form invites a second
          // tap, which would queue the same capture again under a new id.
          if (result?.state === "sent" || result?.state === "queued") form.reset();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">{tr("mobile.capture.fieldTitle")}</Label>
          <Input id="title" name="title" required autoFocus className="min-h-11" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="body">{tr("mobile.noteNew.body")}</Label>
          <Textarea id="body" name="body" rows={6} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tags">{tr("mobile.noteNew.tags")}</Label>
          <Input id="tags" name="tags" className="min-h-11" />
        </div>

        {state === "queued" || state === "signin" ? (
          <p role="status" className="bg-status-warning/15 rounded-md px-3 py-2 text-sm">
            {tr(state === "signin" ? "mobile.capture.queuedSignIn" : "mobile.capture.queued")}
          </p>
        ) : null}
        {state === "refused" && error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={state === "sending"} className="min-h-11 w-full">
          {state === "sending" ? tr("mobile.capture.saving") : tr("mobile.capture.create")}
        </Button>
      </form>

      <CaptureQueueStatus url="/m/notes/new" />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
