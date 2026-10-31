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
import { CaptureQueueStatus, useCaptureSubmit } from "~/components/mobile/capture-form";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

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
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <Link to="/m" className="text-muted-foreground font-mono text-xs">
          {tr("mobile.noteNew.back")}
        </Link>
        <h1 className="mt-1 font-mono text-lg">{tr("mobile.noteNew.title")}</h1>
      </div>

      <form
        className="space-y-4 px-4 py-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await submit(e.currentTarget);
          if (result?.state === "sent") e.currentTarget.reset();
        }}
      >
        <div>
          <label htmlFor="title" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.capture.fieldTitle")}
          </label>
          <input
            id="title"
            name="title"
            required
            autoFocus
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          />
        </div>

        <div>
          <label htmlFor="body" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.noteNew.body")}
          </label>
          <textarea
            id="body"
            name="body"
            rows={6}
            className="border-border bg-background w-full rounded-sm border px-3 py-2 text-base"
          />
        </div>

        <div>
          <label htmlFor="tags" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.noteNew.tags")}
          </label>
          <input
            id="tags"
            name="tags"
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          />
        </div>

        {state === "queued" ? (
          <p role="status" className="text-sm">
            {tr("mobile.capture.queued")}
          </p>
        ) : null}
        {state === "refused" && error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={state === "sending"}
          className="bg-primary text-primary-foreground flex min-h-11 w-full items-center justify-center rounded-sm text-base disabled:opacity-60"
        >
          {state === "sending" ? tr("mobile.capture.saving") : tr("mobile.capture.create")}
        </button>
      </form>

      <div className="px-4 pb-4">
        <CaptureQueueStatus url="/m/notes/new" />
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
