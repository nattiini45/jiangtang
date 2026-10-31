import * as React from "react";
import { useFetcher } from "react-router";
import { formatTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { cn } from "~/lib/utils";
import { MarkdownPreview } from "./markdown-preview";
import {
  applySlashCommand,
  filterSlashCommands,
  slashCommands,
  slashQuery,
  type SlashCommand,
} from "./slash-commands";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";

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
}

const DEBOUNCE_MS = 1500;

export function NoteEditor({
  note,
  projects,
  locations,
}: {
  note: EditableNote;
  projects: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
}) {
  const locale = useLocale();
  const t = useT();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
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

  const save = React.useCallback(() => {
    if (!formRef.current) return;
    if (fetcher.state !== "idle") return; // never overlap two saves
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
      if (inflightRef.current === versionRef.current) setDirty(false);
      else if (debounceRef.current) clearTimeout(debounceRef.current);
      if (inflightRef.current !== versionRef.current) {
        debounceRef.current = setTimeout(save, DEBOUNCE_MS);
      }
      setSavedAt(new Date());
      setSaveError(null);
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

  const statusText = saveError
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
      {/* pinned rides along — updateNote takes the whole document, and a pin
          made via its own button must not be reverted by the next autosave. */}
      <input type="hidden" name="pinned" value={note.pinned ? "true" : ""} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          name="title"
          defaultValue={note.title}
          required
          aria-label={t("notes.editor.titleAria")}
          className="max-w-md font-mono text-base font-semibold"
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
          className={cn(
            "font-mono text-xs",
            saveError ? "text-status-fault" : "text-muted-foreground",
          )}
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
            className="w-28 font-mono text-xs"
          />
        ))}
        <Input
          name="tags"
          placeholder={t("notes.editor.addTagPlaceholder")}
          aria-label={t("notes.editor.addTagAria")}
          className="w-28 font-mono text-xs"
        />
      </div>

      {/* Pane toggle — only reachable under lg, where the grid is one column. */}
      <div className="flex gap-1 lg:hidden" role="group" aria-label={t("notes.editor.viewAria")}>
        <button
          type="button"
          className={cn(
            "border-border rounded-sm border px-2 py-1 text-xs",
            mobilePane === "edit" && "bg-muted",
          )}
          onClick={() => setMobilePane("edit")}
        >
          {t("notes.editor.sourcePane")}
        </button>
        <button
          type="button"
          className={cn(
            "border-border rounded-sm border px-2 py-1 text-xs",
            mobilePane === "preview" && "bg-muted",
          )}
          onClick={() => setMobilePane("preview")}
        >
          {t("notes.editor.previewPane")}
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn("relative", mobilePane === "preview" && "hidden lg:block")}>
          {slash && filtered.length > 0 ? (
            <ul
              role="listbox"
              aria-label={t("notes.editor.insertBlockAria")}
              className="border-border bg-popover absolute left-2 top-2 z-10 min-w-40 rounded-sm border shadow-md"
            >
              {filtered.map((command, i) => (
                <li
                  key={command.id}
                  role="option"
                  aria-selected={i === slash.index}
                  className={cn(
                    "cursor-pointer px-3 py-1.5 text-sm",
                    i === slash.index && "bg-accent text-accent-foreground",
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
          <textarea
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
            className="border-border bg-background focus-visible:outline-primary w-full resize-y rounded-sm border p-3 font-mono text-sm focus-visible:outline-1"
          />
          <p className="text-muted-foreground mt-1 text-xs">{t("notes.editor.bodyHint")}</p>
        </div>
        <div
          className={cn(
            "border-border min-h-32 rounded-sm border p-3",
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
