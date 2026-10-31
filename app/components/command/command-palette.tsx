import * as React from "react";
import { useFetcher, useMatches, useNavigate } from "react-router";
import { cn } from "~/lib/utils";
import { useLocale, useT } from "~/i18n/use-t";
import type { MessageKey } from "~/i18n";
import type { SearchResult, SearchResultType } from "~/routes/api.search/search.server";
import { scoreVerb, verbsFor, type Verb } from "~/components/command/verbs";

/**
 * Global command palette (Ctrl/Cmd-K): verbs + entity results in
 * one ranked list. Mountable with zero wiring: the app shell renders
 * <CommandPalette admin={…} /> once and it manages its own open state via a
 * window keydown listener.
 *
 * One ranked list: verbs (fuzzy-matched on label + keywords) rank first when
 * the query matches them; `api.search` entity results follow, grouped by type
 * with headings in the active language. Enter runs the active row, arrow keys wrap, Escape
 * closes and restores focus to whatever was focused before opening, Tab and
 * Shift+Tab stay trapped inside the dialog, and the combobox exposes
 * `aria-activedescendant`.
 *
 * ⚠️ **A new `SearchResultType` member reaches this file whether or not the
 * change that adds it names this file.** `GROUP_LABEL` is a `Record` over that
 * union, so the compiler *forces* this file: without the new key the typecheck
 * is red and the slice cannot ship.
 * `GROUP_ORDER` then has a second, quieter obligation — a result whose type is
 * not in this list is filtered out and **never renders**, so a key that
 * satisfies the compiler while missing here produces a working search nobody
 * can see.
 */
const GROUP_ORDER: SearchResultType[] = [
  "room",
  "ticket",
  "event",
  "equipment",
  "inventory-item",
  "task",
  "note",
  "project",
  "location",
  "vendor",
];
// Fails `tsc` when a `SearchResultType` has no catalog heading. The hybrid
// index arm can surface task/note/project/location/vendor results too.
const groupLabelKey = (type: SearchResultType): MessageKey => `command.entity.${type}`;

type Row = { kind: "verb"; verb: Verb } | { kind: "result"; result: SearchResult };

export function CommandPalette({ admin = false }: { admin?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const matches = useMatches();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  // Whatever was focused before opening gets focus back on close.
  const restoreRef = React.useRef<HTMLElement | null>(null);

  // The task detail route declares `handle = { palette: "task" }`; its match
  // params carry the task id for the context verbs.
  const taskMatch = matches.find(
    (m) => (m.handle as { palette?: string } | undefined)?.palette === "task",
  );
  const taskId = taskMatch ? (taskMatch.params as { id?: string }).id : undefined;

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setActive(0);
    restoreRef.current?.focus();
    restoreRef.current = null;
  }, []);

  // Global toggle: Ctrl/Cmd-K opens (and focuses) the palette; a second press
  // closes it.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => {
          if (!o) restoreRef.current = document.activeElement as HTMLElement | null;
          return !o;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced entity search. A query shorter than 2 chars clears the list
  // without a request (mirrors the loader's own guard) — the verbs still rank.
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const handle = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data: { results: SearchResult[] }) => {
          setResults(data.results ?? []);
        })
        .catch(() => {
          /* aborted or network error — leave the previous list */
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [query, open]);

  const verbs = React.useMemo(
    () => verbsFor({ admin, context: taskId ? "task" : undefined, locale }),
    [admin, taskId, locale],
  );

  // One ranked list: matched verbs first (score desc, registry order as the
  // tiebreak), then the entity groups in GROUP_ORDER.
  const rows = React.useMemo<Row[]>(() => {
    const scored = verbs
      .map((verb, i) => {
        let score = scoreVerb(verb, query);
        // The catch-all search verb matches every non-empty query — below
        // genuinely-matched verbs, so it stays a fallback, not noise.
        if (score < 0 && verb.id === "search-query" && query.trim() !== "") score = 15;
        return { verb, score, i };
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const verbRows: Row[] = scored.map(({ verb }) => ({ kind: "verb", verb }));
    const entityRows: Row[] = GROUP_ORDER.flatMap((type) =>
      results.filter((r) => r.type === type).map((result) => ({ kind: "result" as const, result })),
    );
    return [...verbRows, ...entityRows];
  }, [verbs, query, results]);

  const entityGroups = React.useMemo(
    () =>
      GROUP_ORDER.map((type) => ({ type, items: results.filter((r) => r.type === type) })).filter(
        (g) => g.items.length > 0,
      ),
    [results],
  );

  const runRow = React.useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "verb") {
        row.verb.run({
          navigate: (to) => {
            void navigate(to);
          },
          submit: (fields, action) => {
            const body = new FormData();
            for (const [k, v] of Object.entries(fields)) body.set(k, v);
            void fetcher.submit(body, { method: "post", action });
          },
          taskId,
          query,
          close,
        });
      } else {
        close();
        void navigate(row.result.href);
      }
    },
    [close, fetcher, navigate, taskId, query],
  );

  // All palette keys handled at the dialog level — keydown bubbles, so they
  // still fire when Tab has moved focus onto an option button.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      // Enter on an option button is its native click — handled by onClick.
      e.preventDefault();
      runRow(rows[Math.min(active, Math.max(rows.length - 1, 0))]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab" && dialogRef.current) {
      // Tab/Shift+Tab stay inside the dialog — a real focus trap.
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'input, button, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = e.shiftKey
        ? idx <= 0
          ? focusables.length - 1
          : idx - 1
        : idx === focusables.length - 1
          ? 0
          : idx + 1;
      focusables[next].focus();
    }
  };

  if (!open) return null;

  // The verb list can shrink between keystrokes before `active` resets —
  // clamp for comparisons + aria so a stale index never points off the end.
  const clamped = Math.min(active, Math.max(rows.length - 1, 0));
  const showEmpty = !loading && query.trim().length >= 2 && rows.length === 0;
  const activeId = `palette-row-${clamped}`;
  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("command.label")}
        onKeyDown={onDialogKeyDown}
        className="bg-popover text-popover-foreground border-border w-full max-w-xl overflow-hidden rounded-sm border shadow-lg"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={rows.length > 0 ? activeId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("command.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          className="border-border placeholder:text-muted-foreground w-full border-b bg-transparent px-3 py-3 text-sm outline-none"
        />

        <div id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto">
          {loading && (
            <p className="text-muted-foreground px-3 py-4 text-sm">{t("command.searching")}</p>
          )}

          {showEmpty && (
            <p className="text-muted-foreground px-3 py-4 text-sm">{t("command.noResults")}</p>
          )}

          {/* Verbs first — the row's flat index feeds aria-activedescendant. */}
          {rows.some((r) => r.kind === "verb") && (
            <div className="border-border border-b last:border-b-0">
              <div className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                {t("command.commands")}
              </div>
              <ul>
                {rows
                  .filter((r): r is Row & { kind: "verb" } => r.kind === "verb")
                  .map((row) => {
                    flatIndex += 1;
                    const idx = flatIndex;
                    const isActive = idx === clamped;
                    return (
                      <li
                        key={row.verb.id}
                        id={`palette-row-${idx}`}
                        role="option"
                        aria-selected={isActive}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => runRow(row)}
                          className={cn(
                            "flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm",
                            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                          )}
                        >
                          <span className="truncate">
                            {row.verb.id === "search-query" && query.trim()
                              ? t("command.searchFor", { query: query.trim() })
                              : row.verb.label}
                          </span>
                          <span className="text-muted-foreground shrink-0 font-mono text-xs">
                            {row.verb.group}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}

          {!loading &&
            entityGroups.map((group) => (
              <div key={group.type} className="border-border border-b last:border-b-0">
                <div className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                  {t(groupLabelKey(group.type))}
                </div>
                <ul>
                  {group.items.map((item) => {
                    flatIndex += 1;
                    const idx = flatIndex;
                    const isActive = idx === clamped;
                    const row: Row = { kind: "result", result: item };
                    return (
                      <li
                        key={`${item.type}:${item.id}`}
                        id={`palette-row-${idx}`}
                        role="option"
                        aria-selected={isActive}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => runRow(row)}
                          className={cn(
                            "flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm",
                            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                          )}
                        >
                          <span className="truncate">{item.label}</span>
                          {item.sublabel && (
                            <span className="text-muted-foreground shrink-0 font-mono text-xs">
                              {item.sublabel}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
