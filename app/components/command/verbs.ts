import { TaskStatus } from "~/generated/prisma/enums";
import { taskAllowedActions } from "~/domains/tasks/tasks.transitions";
import { taskStatusLabel } from "~/components/tasks/labels";
import { NAV } from "~/components/layout/nav";
import { cycleDensity, cycleTheme } from "~/lib/prefs";
import { t, type MessageKey, type MessageParams } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * The command-palette verb registry. A verb is a named action the
 * palette can run — navigation, record creation, UI-preference toggles, admin
 * maintenance, or a mutation on the task whose detail page is open. The
 * palette merges verbs with `api.search` entity results into one ranked list.
 *
 * `run(ctx)` receives a small context the palette assembles:
 * - `navigate` — client-side navigation.
 * - `submit` — posts `fields` as a form body to `action` via `useFetcher`
 *   (task-context verbs hit the task route's `_action` dispatch; the admin
 *   verb hits `/admin/search-index`'s `intent` dispatch).
 * - `taskId` — set when the current route declares `handle = { palette: "task" }`.
 * - `close` — dismisses the palette; every verb closes first so a fetcher
 *   revalidation never fights the overlay.
 */
export interface VerbContext {
  navigate: (to: string) => void;
  submit: (fields: Record<string, string>, action: string) => void;
  taskId?: string;
  /** The palette's current query text — the catch-all search verb uses it. */
  query: string;
  close: () => void;
}

export interface Verb {
  id: string;
  /** Rendered in the palette locale, non-empty — the unit test asserts both languages. */
  label: string;
  keywords: string[];
  group: string;
  adminOnly?: boolean;
  /** Offered only while a matching route handle is in the match list. */
  context?: "task";
  taskStatus?: TaskStatus;
  run: (ctx: VerbContext) => void;
}

export const TASK_STATUSES: TaskStatus[] = [
  TaskStatus.BACKLOG,
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
  TaskStatus.DONE,
  TaskStatus.CANCELLED,
];

/** "Titel bearbeiten": open the edit section, focus + select the title input. */
function focusTaskTitleInput(): void {
  const input = document.querySelector<HTMLInputElement>("input[name='title']");
  if (!input) return;
  input.closest("details")?.setAttribute("open", "");
  input.focus();
  input.select();
}

/**
 * Extra English words that only the English palette matches, so German queries
 * rank exactly as they did before the UI had a second language.
 */
const ENGLISH_KEYWORDS: Record<string, string[]> = {
  "new-task": ["new", "create", "add"],
  "new-note": ["new", "create", "add"],
  "new-project": ["new", "create", "add"],
  "new-ticket": ["new", "create", "incident", "fault", "log"],
  "toggle-theme": ["mode", "switch"],
  "toggle-density": ["rows", "switch"],
  "admin-index-reconcile": ["search index"],
  "task-assign-me": ["me", "assignee", "take"],
  "task-edit-title": ["rename"],
};

function buildVerbs(locale: Locale): Verb[] {
  const tr = (key: MessageKey, params?: MessageParams) => t(locale, key, params);
  const group = {
    navigation: tr("command.group.navigation"),
    create: tr("command.group.create"),
    view: tr("command.group.view"),
    admin: tr("command.group.admin"),
    task: tr("command.group.task"),
  };

  const verbs: Verb[] = [
    // ── Navigation — derived from the shared nav list (one source of truth). ──
    ...NAV.map((entry): Verb => ({
      id: `goto-${entry.to.replaceAll("/", "") || "index"}`,
      label: tr("command.verb.goto", { label: tr(entry.labelKey) }),
      keywords: [
        entry.to,
        t("de", entry.labelKey).toLowerCase(),
        ...(locale === "en" ? [t("en", entry.labelKey).toLowerCase()] : []),
        "navigation",
        "öffnen",
      ],
      group: group.navigation,
      adminOnly: entry.adminOnly,
      run: (ctx) => {
        ctx.close();
        ctx.navigate(entry.to);
      },
    })),

    // ── Create ────────────────────────────────────────────────────────────────
    {
      id: "new-task",
      label: tr("command.verb.newTask"),
      keywords: ["neu", "task", "erstellen", "anlegen"],
      group: group.create,
      run: (ctx) => {
        ctx.close();
        ctx.navigate("/tasks/new");
      },
    },
    {
      id: "new-note",
      label: tr("command.verb.newNote"),
      keywords: ["neu", "note", "erstellen"],
      group: group.create,
      run: (ctx) => {
        ctx.close();
        ctx.navigate("/notes/new");
      },
    },
    {
      id: "new-project",
      label: tr("command.verb.newProject"),
      keywords: ["neu", "project", "erstellen"],
      group: group.create,
      run: (ctx) => {
        ctx.close();
        ctx.navigate("/projects/new");
      },
    },
    {
      id: "new-ticket",
      label: tr("command.verb.newTicket"),
      keywords: ["neu", "ticket", "störung", "erstellen"],
      group: group.create,
      run: (ctx) => {
        ctx.close();
        ctx.navigate("/tickets/new");
      },
    },

    // ── Search catch-all — always matches a non-empty query (the palette gives
    // it a fallback score when the fuzzy matcher misses). ─────────────────────
    {
      id: "search-query",
      label: tr("command.verb.searchQuery"),
      keywords: ["suchen", "search", "finden"],
      group: group.navigation,
      run: (ctx) => {
        ctx.close();
        ctx.navigate(`/search?q=${encodeURIComponent(ctx.query.trim())}`);
      },
    },

    // ── View / maintenance ────────────────────────────────────────────────────
    {
      id: "toggle-theme",
      label: tr("command.verb.toggleTheme"),
      keywords: ["theme", "dark", "light", "hell", "dunkel", "modus"],
      group: group.view,
      run: (ctx) => {
        ctx.close();
        cycleTheme();
      },
    },
    {
      id: "toggle-density",
      label: tr("command.verb.toggleDensity"),
      keywords: ["density", "kompakt", "compact", "comfortable", "zeilen"],
      group: group.view,
      run: (ctx) => {
        ctx.close();
        cycleDensity();
      },
    },
    {
      id: "admin-index-reconcile",
      label: tr("command.verb.reconcileIndex"),
      keywords: ["index", "reindex", "suche", "reconcile"],
      group: group.admin,
      adminOnly: true,
      run: (ctx) => {
        ctx.close();
        ctx.submit({ intent: "reconcile" }, "/admin/search-index");
      },
    },

    // ── Task context — offered only on a task detail page. ───────────────────
    {
      id: "task-assign-me",
      label: tr("command.verb.assignMe"),
      keywords: ["assign", "zuständig", "zuweisen", "übernehmen"],
      group: group.task,
      context: "task",
      run: (ctx) => {
        ctx.close();
        if (ctx.taskId) ctx.submit({ _action: "assign-me" }, `/tasks/${ctx.taskId}`);
      },
    },
    ...TASK_STATUSES.map((status): Verb => ({
      id: `task-set-status-${status.toLowerCase()}`,
      taskStatus: status,
      label: tr("command.verb.setStatus", { status: taskStatusLabel(locale, status) }),
      keywords: [
        "status",
        "setzen",
        status.toLowerCase(),
        taskStatusLabel("de", status).toLowerCase(),
        taskStatusLabel("en", status).toLowerCase(),
      ],
      group: group.task,
      context: "task",
      run: (ctx) => {
        ctx.close();
        if (ctx.taskId) ctx.submit({ _action: "set-status", status }, `/tasks/${ctx.taskId}`);
      },
    })),
    {
      id: "task-edit-title",
      label: tr("command.verb.editTitle"),
      keywords: ["titel", "title", "umbenennen", "edit"],
      group: group.task,
      context: "task",
      run: (ctx) => {
        ctx.close();
        focusTaskTitleInput();
      },
    },
  ];
  return locale === "en"
    ? verbs.map((v) => ({ ...v, keywords: [...v.keywords, ...(ENGLISH_KEYWORDS[v.id] ?? [])] }))
    : verbs;
}

const VERB_CACHE = new Map<Locale, Verb[]>();

/** The full verb registry rendered in `locale` (built once per locale). */
export function verbsIn(locale: Locale): Verb[] {
  let verbs = VERB_CACHE.get(locale);
  if (!verbs) {
    verbs = buildVerbs(locale);
    VERB_CACHE.set(locale, verbs);
  }
  return verbs;
}
/**
 * The verbs a given user/context may run: admin verbs only for admins,
 * `context` verbs only while that context is active.
 */
export function verbsFor(opts: {
  admin: boolean;
  context?: "task";
  task?: { status: TaskStatus };
  locale: Locale;
}): Verb[] {
  const allowed = opts.task ? taskAllowedActions(opts.task.status) : [];
  return verbsIn(opts.locale).filter(
    (v) =>
      (!v.adminOnly || opts.admin) &&
      (!v.context || v.context === opts.context) &&
      (!v.taskStatus || allowed.some((action) => action.allowed && action.target === v.taskStatus)),
  );
}

export function paletteTask(matches: readonly { handle?: unknown; data?: unknown }[]) {
  const match = matches.find(
    (entry) => (entry.handle as { palette?: string } | undefined)?.palette === "task",
  );
  const task = (match?.data as { task?: { id?: string; status?: TaskStatus } } | undefined)?.task;
  return task?.id && task.status && TASK_STATUSES.includes(task.status)
    ? { id: task.id, status: task.status }
    : undefined;
}

export function commandRejection(data: unknown): string | undefined {
  const result = data as
    { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
  return result?.formErrors?.[0] ?? Object.values(result?.fieldErrors ?? {}).flat()[0];
}

/**
 * Fuzzy verb match — a small scorer, no dependency: substring hits rank above
 * subsequence hits, matching earlier in the word ranks higher; label beats
 * keywords. Returns -1 for no match, otherwise a positive score (higher =
 * better). An empty query lists every verb (score 1).
 */
export function scoreVerb(verb: Verb, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") return 1;
  const fields: { text: string; weight: number }[] = [
    { text: verb.label.toLowerCase(), weight: 3 },
    ...verb.keywords.map((k) => ({ text: k.toLowerCase(), weight: 1 })),
  ];
  let best = -1;
  for (const { text, weight } of fields) {
    const at = text.indexOf(q);
    if (at === 0) best = Math.max(best, 100 * weight + Math.max(0, 30 - text.length));
    else if (at > 0) best = Math.max(best, 60 * weight + Math.max(0, 30 - at));
    else if (isSubsequence(q, text)) best = Math.max(best, 20 * weight);
  }
  return best;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
