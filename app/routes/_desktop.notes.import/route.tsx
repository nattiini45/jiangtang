import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { importMarkdownNotes } from "~/domains/notes/notes.import.server";
import { NoteFormErrors } from "~/components/notes/note-form-errors";
import { Button } from "~/components/ui/button";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/notes/import` — markdown folder/file ingest. Unlike the CSV
 * importers there is no paste-preview round trip: uploaded `File`s cannot
 * survive a second POST, so this is single-step — validate the envelope,
 * commit atomically, then report created/updated. A rejected file aborts the
 * WHOLE batch inside `importMarkdownNotes`' one `txWithAudit`, and the error
 * names the file.
 *
 * Limits: 200 files, 2 MB each — a notes folder, not a filesystem dump.
 * Both a multi-file picker and a directory picker (`webkitdirectory`) feed
 * the same `files` field.
 */
const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "notes.meta.import") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) {
    return { error: null, done: null, formErrors: [t(locale, "err.notesImport.noFile")] };
  }
  if (files.length > MAX_FILES) {
    return {
      formErrors: [
        t(locale, "err.notesImport.tooManyFiles", { count: files.length, max: MAX_FILES }),
      ],
    };
  }
  const oversized = files.filter((f) => f.size > MAX_BYTES);
  if (oversized.length > 0) {
    return {
      formErrors: oversized.map((f) =>
        t(locale, "err.notesImport.fileTooLarge", {
          name: f.name,
          sizeKb: Math.round(f.size / 1024),
          maxMb: MAX_BYTES / 1024 / 1024,
        }),
      ),
    };
  }

  const payload = await Promise.all(
    files.map(async (f) => ({ name: f.name, text: await f.text() })),
  );
  try {
    const result = await importMarkdownNotes(actor, payload);
    await emitChange({ entityType: "note", id: "bulk", op: "created" });
    return {
      done: { created: result.created, updated: result.updated, names: files.map((f) => f.name) },
    };
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        formErrors: [
          t(locale, "notes.import.rejected"),
          ...e.formErrors,
          ...Object.values(e.fieldErrors).flat(),
        ],
      };
    }
    throw toErrorResponse(e);
  }
}

export default function NotesImport({ actionData }: Route.ComponentProps) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("notes.import.title")}</h1>
        <Link to="/notes" className="text-muted-foreground text-sm hover:underline">
          {t("notes.import.back")}
        </Link>
      </div>

      <NoteFormErrors formErrors={actionData?.formErrors} />

      {actionData?.done ? (
        <div role="status" className="bg-card shadow-surface-2 rounded-lg p-4 text-sm">
          <p className="font-semibold">
            {t("notes.import.done", {
              created: actionData.done.created,
              updated: actionData.done.updated,
            })}
          </p>
          <ul className="text-muted-foreground mt-2 max-h-48 overflow-auto font-mono text-xs">
            {actionData.done.names.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <Button asChild variant="secondary" size="compact" className="mt-3">
            <Link to="/notes">{t("notes.import.backToList")}</Link>
          </Button>
        </div>
      ) : (
        <form
          method="post"
          encType="multipart/form-data"
          className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-4"
        >
          <p className="text-muted-foreground text-sm">{t("notes.import.description")}</p>
          <input
            type="file"
            name="files"
            multiple
            accept=".md,.markdown,text/markdown,text/plain"
            className="text-muted-foreground text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-tint file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-foreground file:transition-colors hover:file:bg-tint-hover"
            aria-label={t("notes.import.pickFilesAria")}
          />
          <input
            type="file"
            name="files"
            // webkitdirectory: non-standard attribute, the only directory
            // picker — spread so the TS DOM types (which don't know it) pass.
            {...({ webkitdirectory: "" } as Record<string, string>)}
            className="text-muted-foreground text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-tint file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-foreground file:transition-colors hover:file:bg-tint-hover"
            aria-label={t("notes.import.pickFolderAria")}
          />
          <p className="text-muted-foreground text-xs">
            {t("notes.import.limits", { maxFiles: MAX_FILES, maxMb: MAX_BYTES / 1024 / 1024 })}
          </p>
          <Button type="submit" className="self-start">
            {t("common.import")}
          </Button>
        </form>
      )}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
