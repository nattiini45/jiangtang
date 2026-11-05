import * as React from "react";
import { useFetcher, useRevalidator } from "react-router";
import { formatTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { cn } from "~/lib/utils";
import { draftToMarkdown } from "~/domains/notes/notes.markdown";
import { MarkdownPreview } from "./markdown-preview";
import {
  applySlashCommand,
  filterSlashCommands,
  slashCommands,
  slashQuery,
  type SlashCommand,
} from "./slash-commands";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

/**
 * The `/notes/:id` editor: monospace source on the left, rendered
 * preview on the right, and an autosave that debounces 1.5 s after the last
 * edit and posts the WHOLE form (`intent=autosave`) through `useFetcher` — the
 * action is `updateNote`, whose no-op short-circuit makes a save that changed
 * nothing free.
 *
 * Status line contract: saving… while a request is in flight or a save is
 * pending, "saved HH:MM" after a clean write, "not saved — …"
 * when the action answers an error. Ctrl/Cmd+S saves immediately;
 * `beforeunload` warns while dirty.
 *
 * Concurrency: every save carries the `version` this editor loaded (advanced
 * by each clean write). A save against a newer stored version comes back as
 * `{conflict}`; autosave then stops and an alert offers to load the stored
 * version (remounting the form from it) or to download the local draft (title,
 * body, tags, project, location) as a Markdown file that the note import
 * accepts as a new note. Nothing local is discarded until the person chooses
 * to reload.
 *
 * The `/` command row: `/` at the start of a line opens a listbox filtered by
 * what follows; arrows + Enter insert, Escape closes. The insertion itself is
 * pure (`slash-commands.ts`) — this file only wires the textarea to it.
 */

export interface EditableNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  projectId: string | null;
  locationId: string | null;
  version: number;
}

interface SaveResult {
  ok?: boolean;
  version?: number;
  error?: string;
  conflict?: { message: string; current: EditableNote };
}

const DEBOUNCE_MS = 1500;

type Options = Array<{ id: string; name: string }>;
type ProjectOptions = Array<{ id: string; name: string; slug: string }>;

export function NoteEditor({
  note,
  projects,
  locations,
}: {
  note: EditableNote;
  projects: ProjectOptions;
  locations: Options;
}) {
  const revalidator = useRevalidator();
  // The loader's note seeds the form once; later loader data must not replace
  // what the person is typing. Only an explicit reload after a conflict swaps
  // the base and remounts the form.
  const [base, setBase] = React.useState(note);
  const [generation, setGeneration] = React.useState(0);
  // The conflict snapshot or the revalidated loader note, whichever is newer:
  // a save landing after the conflict must not leave the form one version behind.
  const latestRef = React.useRef(note);
  latestRef.current = note;
  const reload = React.useCallback(
    (current: EditableNote) => {
      const latest = latestRef.current;
      setBase(latest.version > current.version ? latest : current);
      setGeneration((g) => g + 1);
      void revalidator.revalidate();
    },
    [revalidator],
  );
  return (
    <NoteEditorForm
      key={generation}
      note={base}
      pinned={note.pinned}
      projects={projects}
      locations={locations}
      onReload={reload}
    />
  );
}

function NoteEditorForm({
  note,
  pinned,
  projects,
  locations,
  onReload,
}: {
  note: EditableNote;
  pinned: boolean;
  projects: ProjectOptions;
  locations: Options;
  onReload: (current: EditableNote) => void;
}) {
  const locale = useLocale();
  const t = useT();
  const fetcher = useFetcher<SaveResult>();
  const formRef = React.useRef<HTMLFormElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = React.useRef(0);
  const inflightRef = React.useRef(-1);

  const [body, setBody] = React.useState(note.body);
  const [dirty, setDirty] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [mobilePane, setMobilePane] = React.useState<"edit" | "preview">("edit");
  const [slash, setSlash] = React.useState<{ query: string; index: number } | null>(null);
  const [version, setVersion] = React.useState(note.version);
  const [conflict, setConflict] = React.useState<SaveResult["conflict"] | null>(null);
  const conflictRef = React.useRef(false);

  const save = React.useCallback(() => {
    if (!formRef.current) return;
    if (fetcher.state !== "idle") return; // never overlap two saves
    if (conflictRef.current) return; // every further save would be refused too
    inflightRef.current = versionRef.current;
    void fetcher.submit(formRef.current, { method: "post" });
  }, [fetcher]);

  const markDirty = React.useCallback(() => {
    versionRef.current++;
    setDirty(true);
    setSaveError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(save, DEBOUNCE_MS);
  }, [save]);

  // A finished save clears dirty ONLY if nothing was typed after it went out
  // (the version comparison) — and if the user kept typing while it was in
  // flight, the leftover dirty schedules the next save here.
  React.useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      if (fetcher.data.version !== undefined) setVersion(fetcher.data.version);
      if (inflightRef.current === versionRef.current) setDirty(false);
      else if (debounceRef.current) clearTimeout(debounceRef.current);
      if (inflightRef.current !== versionRef.current) {
        debounceRef.current = setTimeout(save, DEBOUNCE_MS);
      }
      setSavedAt(new Date());
      setSaveError(null);
    } else if (fetcher.state === "idle" && fetcher.data?.conflict) {
      conflictRef.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setConflict(fetcher.data.conflict);
    } else if (fetcher.state === "idle" && fetcher.data?.error) {
      setSaveError(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data, save]);

  React.useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // Ctrl/Cmd+S saves immediately — a keystroke users of a text editor bring.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Warn while dirty — an autosave in flight or a debounce pending both count.
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** `/`-row bookkeeping: recompute the query on every caret/content change. */
  const refreshSlash = React.useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const state = slashQuery(ta.value, ta.selectionStart ?? ta.value.length);
    setSlash(state ? { query: state.query, index: 0 } : null);
  }, []);

  const insertCommand = React.useCallback(
    (command: SlashCommand) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const applied = applySlashCommand(ta.value, ta.selectionStart ?? ta.value.length, command);
      setSlash(null);
      if (!applied) return;
      setBody(applied.text);
      markDirty();
      // Let React flush the controlled value before moving the caret.
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(applied.cursor, applied.cursor);
      });
    },
    [markDirty],
  );

  const commands = React.useMemo(() => slashCommands(locale), [locale]);
  const filtered = slash ? filterSlashCommands(slash.query, commands) : [];

  function onBodyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!slash || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSlash({ ...slash, index: (slash.index + 1) % filtered.length });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSlash({ ...slash, index: (slash.index - 1 + filtered.length) % filtered.length });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertCommand(filtered[slash.index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSlash(null);
    }
  }

  const downloadLocalCopy = React.useCallback(() => {
    const form = formRef.current ? new FormData(formRef.current) : null;
    const field = (name: string) => String(form?.get(name) ?? "").trim();
    const title = field("title");
    const projectId = field("projectId");
    const text = draftToMarkdown({
      title: title || note.title,
      body,
      tags: (form?.getAll("tags") ?? []).map((v) => String(v).trim()).filter((v) => v !== ""),
      pinned,
      projectSlug: projects.find((p) => p.id === projectId)?.slug,
      locationId: field("locationId") || undefined,
    });
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileStem(title || note.title)}.md`;
    a.click();
    // Revoking in the same task can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [body, note.title, pinned, projects]);

  const statusText = conflict
    ? t("notes.editor.notSaved", { error: conflict.message })
    : saveError
      ? t("notes.editor.notSaved", { error: saveError })
      : fetcher.state !== "idle"
        ? t("common.saving")
        : dirty
          ? t("common.saving")
          : savedAt
            ? t("notes.editor.savedAt", { time: formatTime(locale, savedAt) })
            : "";

  return (
    <form
      ref={formRef}
      method="post"
      onChange={markDirty}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="_action" value="autosave" />
      <input type="hidden" name="version" value={version} />
      {/* pinned rides along — updateNote takes the whole document, and a pin
          made via its own button must not be reverted by the next autosave. */}
      <input type="hidden" name="pinned" value={pinned ? "true" : ""} />

      {conflict ? (
        <div
          role="alert"
          className="bg-destructive/15 text-foreground flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-3 py-2 text-sm"
        >
          <p className="min-w-0 flex-1">
            {conflict.message} {t("notes.editor.conflict.hint")}
          </p>
          <Button type="button" size="compact" variant="secondary" onClick={downloadLocalCopy}>
            {t("notes.editor.conflict.download")}
          </Button>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            onClick={() => {
              if (dirty && !confirm(t("notes.editor.conflict.confirmReload"))) return;
              onReload(conflict.current);
            }}
          >
            {t("notes.editor.conflict.reload")}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          name="title"
          defaultValue={note.title}
          required
          aria-label={t("notes.editor.titleAria")}
          className="max-w-md text-base font-semibold"
        />
        <Select
          name="projectId"
          defaultValue={note.projectId ?? ""}
          aria-label={t("notes.editor.projectAria")}
          className="max-w-[14rem]"
        >
          <option value="">{t("notes.editor.noProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          name="locationId"
          defaultValue={note.locationId ?? ""}
          aria-label={t("notes.editor.locationAria")}
          className="max-w-[14rem]"
        >
          <option value="">{t("notes.editor.noLocation")}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <span
          role="status"
          aria-live="polite"
          className={cn("nums text-xs", saveError ? "text-status-fault" : "text-muted-foreground")}
        >
          {statusText}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {note.tags.map((tag, i) => (
          <Input
            key={i}
            name="tags"
            defaultValue={tag}
            aria-label={t("notes.editor.tagAria", { n: i + 1 })}
            className="w-28 text-xs"
          />
        ))}
        <Input
          name="tags"
          placeholder={t("notes.editor.addTagPlaceholder")}
          aria-label={t("notes.editor.addTagAria")}
          className="w-28 text-xs"
        />
      </div>

      {/* Pane toggle — only reachable under lg, where the grid is one column. */}
      <div className="flex gap-1 lg:hidden" role="group" aria-label={t("notes.editor.viewAria")}>
        <Button
          type="button"
          size="compact"
          variant={mobilePane === "edit" ? "secondary" : "ghost"}
          onClick={() => setMobilePane("edit")}
        >
          {t("notes.editor.sourcePane")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant={mobilePane === "preview" ? "secondary" : "ghost"}
          onClick={() => setMobilePane("preview")}
        >
          {t("notes.editor.previewPane")}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn("relative", mobilePane === "preview" && "hidden lg:block")}>
          {slash && filtered.length > 0 ? (
            <ul
              role="listbox"
              aria-label={t("notes.editor.insertBlockAria")}
              className="bg-popover shadow-surface-3 absolute left-2 top-2 z-10 min-w-40 rounded-lg p-1"
            >
              {filtered.map((command, i) => (
                <li
                  key={command.id}
                  role="option"
                  aria-selected={i === slash.index}
                  className={cn(
                    "cursor-pointer rounded-md px-3 py-1.5 text-sm",
                    i === slash.index && "bg-selected",
                  )}
                  // mousedown before the textarea's blur swallows the click
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertCommand(command);
                  }}
                >
                  {command.label}
                </li>
              ))}
            </ul>
          ) : null}
          <Textarea
            ref={textareaRef}
            name="body"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              refreshSlash();
            }}
            onKeyDown={onBodyKeyDown}
            onKeyUp={refreshSlash}
            onClick={refreshSlash}
            rows={18}
            aria-label={t("notes.editor.bodyAria")}
            placeholder={t("notes.editor.bodyPlaceholder")}
            className="resize-y font-mono"
          />
          <p className="text-muted-foreground mt-1 text-xs">{t("notes.editor.bodyHint")}</p>
        </div>
        <div
          className={cn(
            "bg-card shadow-surface-2 min-h-32 rounded-lg p-3 lg:p-4",
            mobilePane === "edit" && "hidden lg:block",
          )}
        >
          {body.trim() ? (
            <MarkdownPreview source={body} />
          ) : (
            <p className="text-muted-foreground text-sm">{t("notes.editor.previewEmpty")}</p>
          )}
        </div>
      </div>
    </form>
  );
}

/** A download name from the note title: path and control characters out. */
function fileStem(title: string): string {
  // Control characters are exactly what must go from a file name.
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\\/:*?"<>|\u0000-\u001f]+/g;
  const stem = title.replace(unsafe, "-").slice(0, 80).trim();
  return stem || "note";
}
