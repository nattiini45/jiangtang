import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import {
  archiveNote,
  deleteNote,
  setNotePinned,
  unarchiveNote,
  updateNote,
} from "~/domains/notes/notes.mutations.server";
import { getNote } from "~/domains/notes/notes.queries.server";
import { noteCreateSchema } from "~/domains/notes/notes.schema";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listLocationOptions } from "~/domains/locations/locations.queries.server";
import { listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { NoteEditor } from "~/components/notes/note-editor";
import { NoteFormErrors } from "~/components/notes/note-form-errors";
import { ActivityFeed } from "~/components/history/activity-feed";
import { DateCell } from "~/components/data-grid";
import { Button } from "~/components/ui/button";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/notes/:id` — the note editor. One `action` dispatches on `_action`:
 *
 * - `autosave` — the fetcher path. `updateNote` on the whole document, answers
 *   `{ok}`/`{error}` JSON; a redirect would tear the editor down every 1.5 s.
 * - `pin` / `unpin`, `archive` / `unarchive`, `delete` — document posts that
 *   redirect back to the note (or to `/notes` after delete); refusals render
 *   as form errors, not error pages.
 *
 * „Exportieren" is a plain link to the `notes.$id.export` resource route.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "notes.meta.detail", {
        name: data?.note.title ?? t(locale, "notes.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const locale = resolveLocale(request);
  const note = await getNote(params.id);
  if (!note) throw toErrorResponse(new NotFoundError(t(locale, "err.note.notFound")));
  const [projects, locations, history] = await Promise.all([
    listProjectOptions(),
    listLocationOptions(),
    listEntityHistory("note", params.id),
  ]);
  return { note, projects, locations, history };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "autosave");
  const id = params.id;
  const touched = () => emitChange({ entityType: "note", id, op: "updated" });
  try {
    switch (intent) {
      case "autosave": {
        const result = safeParse(noteCreateSchema, formDataToObject(form), locale);
        if (!result.success) {
          const message =
            result.formErrors[0] ??
            Object.values(result.fieldErrors).flat()[0] ??
            t(locale, "err.invalidInput");
          return { error: message };
        }
        await updateNote(actor, id, result.data);
        await touched();
        return { ok: true as const };
      }
      case "pin": {
        await setNotePinned(actor, id, true);
        await touched();
        return redirect(`/notes/${id}`);
      }
      case "unpin": {
        await setNotePinned(actor, id, false);
        await touched();
        return redirect(`/notes/${id}`);
      }
      case "archive": {
        await archiveNote(actor, id);
        await touched();
        return redirect(`/notes/${id}`);
      }
      case "unarchive": {
        await unarchiveNote(actor, id);
        await touched();
        return redirect(`/notes/${id}`);
      }
      case "delete": {
        await deleteNote(actor, id);
        await emitChange({ entityType: "note", id, op: "deleted" });
        return redirect("/notes");
      }
      default:
        throw new ValidationError({}, [t(locale, "err.unknownActionNamed", { intent })]);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      // The autosave path speaks {error}; document posts speak formErrors.
      if (intent === "autosave") {
        return {
          error:
            e.formErrors[0] ??
            Object.values(e.fieldErrors).flat()[0] ??
            t(locale, "err.note.saveRejected"),
        };
      }
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function NoteDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { note, projects, locations, history } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const archived = note.archivedAt !== null;
  const t = useT();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl">{note.title}</h1>
          {note.pinned ? (
            <span className="font-mono text-xs">{t("notes.detail.pinned")}</span>
          ) : null}
          {archived ? (
            <span className="border-border text-muted-foreground rounded-sm border px-1.5 py-0.5 font-mono text-xs">
              {t("notes.detail.archived")}
            </span>
          ) : null}
        </div>
        <Link to="/notes" className="text-muted-foreground text-sm hover:underline">
          {t("notes.detail.back")}
        </Link>
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{t("notes.detail.author", { name: note.author.name })}</span>
        <span>
          {t("notes.detail.updatedLabel")} <DateCell value={note.updatedAt} />
        </span>
        <a href={`/notes/${note.id}/export`} className="text-foreground hover:underline" download>
          {t("notes.detail.export")}
        </a>
      </div>

      <NoteFormErrors formErrors={actionData?.formErrors} />

      <div className="flex flex-wrap items-center gap-2">
        <Form method="post">
          <input type="hidden" name="_action" value={note.pinned ? "unpin" : "pin"} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {note.pinned ? t("notes.detail.unpin") : t("notes.detail.pin")}
          </Button>
        </Form>
        <Form method="post">
          <input type="hidden" name="_action" value={archived ? "unarchive" : "archive"} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {archived ? t("notes.detail.unarchive") : t("notes.detail.archive")}
          </Button>
        </Form>
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(t("notes.detail.confirmDelete"))) e.preventDefault();
          }}
        >
          <input type="hidden" name="_action" value="delete" />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {t("notes.detail.delete")}
          </Button>
        </Form>
      </div>

      <NoteEditor
        key={note.id}
        note={note}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      />

      <section className="border-border border">
        <header className="border-border border-b px-3 py-2">
          <h2 className="text-sm font-medium">{t("notes.detail.history")}</h2>
        </header>
        <ActivityFeed entries={history} />
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
