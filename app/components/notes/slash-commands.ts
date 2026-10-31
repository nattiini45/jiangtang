import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * `/`-command row for the notes editor — pure and client-safe.
 *
 * Typing `/` at the START of a line opens the listbox; every following
 * non-space character filters it. `applySlashCommand` swaps the `/query`
 * fragment for the command's snippet and reports the new cursor position —
 * block commands land the cursor INSIDE their skeleton (code fence, table).
 *
 * The labels are localized per locale; the `insert` snippets are markdown
 * syntax (never translated) — "[Text](…)" reads the same in both languages.
 */

export interface SlashCommand {
  id: string;
  label: string;
  /** The markdown that replaces the `/query` fragment. */
  insert: string;
  /** Cursor position inside `insert` (defaults to its end). */
  cursorOffset?: number;
}

/** The command list in `locale`; the `insert` snippets are locale-independent. */
export function slashCommands(locale: Locale): SlashCommand[] {
  return [
    { id: "h1", label: t(locale, "notes.slash.h1"), insert: "# " },
    { id: "h2", label: t(locale, "notes.slash.h2"), insert: "## " },
    { id: "h3", label: t(locale, "notes.slash.h3"), insert: "### " },
    { id: "ul", label: t(locale, "notes.slash.ul"), insert: "- " },
    { id: "ol", label: t(locale, "notes.slash.ol"), insert: "1. " },
    { id: "todo", label: t(locale, "notes.slash.todo"), insert: "- [ ] " },
    {
      id: "table",
      label: t(locale, "notes.slash.table"),
      insert: "| | | |\n| --- | --- | --- |\n| | | |\n",
      cursorOffset: 2,
    },
    { id: "code", label: t(locale, "notes.slash.code"), insert: "```\n\n```\n", cursorOffset: 4 },
    { id: "quote", label: t(locale, "notes.slash.quote"), insert: "> " },
    { id: "hr", label: t(locale, "notes.slash.hr"), insert: "---\n" },
    {
      id: "link",
      label: t(locale, "notes.slash.link"),
      insert: "[Text](https://)",
      cursorOffset: 1,
    },
  ];
}

/** German list — the pinned test locale (`DEFAULT_LOCALE=de`) and the fallback. */
export const SLASH_COMMANDS: SlashCommand[] = slashCommands("de");

/**
 * The `/query` the cursor is currently typing, or `null` when the listbox
 * should be closed: `/` must be the line's FIRST character, and the query is
 * everything after it up to the cursor — a space or a mid-line slash is not a
 * command.
 */
export function slashQuery(
  text: string,
  cursor: number,
): { lineStart: number; query: string } | null {
  if (cursor < 1 || cursor > text.length) return null;
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const fragment = text.slice(lineStart, cursor);
  if (!/^\/\S*$/.test(fragment)) return null;
  return { lineStart, query: fragment.slice(1) };
}

/** Case-insensitive substring match on the label, prefix on the id. */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  return commands.filter((c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q));
}

/**
 * Replace the `/query` fragment under the cursor with `command.insert`.
 * Returns `null` when the cursor is not in a `/query` (caller just closes the
 * listbox). The returned cursor lands at `cursorOffset` inside the snippet so
 * the user types where the content goes, not after the boilerplate.
 */
export function applySlashCommand(
  text: string,
  cursor: number,
  command: SlashCommand,
): { text: string; cursor: number } | null {
  const state = slashQuery(text, cursor);
  if (!state) return null;
  const offset = command.cursorOffset ?? command.insert.length;
  return {
    text: text.slice(0, state.lineStart) + command.insert + text.slice(cursor),
    cursor: state.lineStart + offset,
  };
}
