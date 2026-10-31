import { useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { sourceTypeLabel } from "~/lib/search/labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * „Frage stellen": POSTs `{question}` to /api/ask and renders what comes
 * back — `results-only` (no generation provider → reason + cited hits, never
 * an error), `no-sources`, or the SSE stream (`sources` → `delta`… → `done`).
 * After `done`, `[n]` markers become links to the numbered sources, uncited
 * paragraphs get the „ohne Beleg" badge, and an answer with no valid
 * citations is replaced — the sources stay visible either way.
 */

interface AskSourceItem {
  n: number;
  title: string;
  href: string | null;
  anchor: string;
  sourceType: string;
}

interface AskHit {
  sourceType: string;
  sourceId: string;
  title: string;
  snippet: string;
  href: string | null;
  ordinal: number;
}

interface DonePayload {
  paragraphs: { text: string; citations: number[]; uncited: boolean }[];
  noAnswer: boolean;
  ok: boolean;
}

type AskState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "streaming"; sources: AskSourceItem[]; text: string }
  | { phase: "done"; sources: AskSourceItem[]; validation: DonePayload }
  | { phase: "results-only"; reason: string; results: AskHit[] }
  | { phase: "no-sources" }
  | { phase: "error"; message: string };

/** Renders `[n]` citation markers as links to the numbered source list. */
function CitedText({ text }: { text: string }) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        if (m) {
          return (
            <a
              key={i}
              href={`#ask-source-${m[1]}`}
              className="text-primary font-mono text-xs hover:underline"
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function SourceList({ sources }: { sources: AskSourceItem[] }) {
  const locale = useLocale();
  return (
    <ol className="mt-3 flex flex-col gap-1.5">
      {sources.map((s) => (
        <li key={s.n} id={`ask-source-${s.n}`} className="flex items-baseline gap-2 text-sm">
          <span className="text-muted-foreground shrink-0 font-mono text-xs">[{s.n}]</span>
          <span className="border-border bg-secondary text-secondary-foreground inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-xs">
            {sourceTypeLabel(locale, s.sourceType)}
          </span>
          {s.href ? (
            <Link to={s.href} className="truncate font-medium hover:underline">
              {s.title}
            </Link>
          ) : (
            <span className="text-muted-foreground truncate font-medium">{s.title}</span>
          )}
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
            {s.anchor}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Pulls `event:`/`data:` blocks out of the SSE byte stream. */
async function readSse(
  res: Response,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join("\n"));
    }
  }
}

export function AskBox() {
  const t = useT();
  const [state, setState] = useState<AskState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  async function ask(question: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "loading" });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setState({ phase: "error", message: data?.error ?? t("search.ask.busy") });
        return;
      }
      const contentType = res.headers.get("Content-Type") ?? "";
      if (contentType.includes("text/event-stream")) {
        let sources: AskSourceItem[] = [];
        let text = "";
        setState({ phase: "streaming", sources: [], text: "" });
        await readSse(res, (event, data) => {
          if (event === "sources") {
            sources = JSON.parse(data) as AskSourceItem[];
          } else if (event === "delta") {
            text += JSON.parse(data) as string;
            setState({ phase: "streaming", sources, text });
          } else if (event === "done") {
            setState({
              phase: "done",
              sources,
              validation: JSON.parse(data) as DonePayload,
            });
          } else if (event === "error") {
            const payload = JSON.parse(data) as { message?: string };
            setState({ phase: "error", message: payload.message ?? t("search.ask.error") });
          }
        });
        return;
      }
      const data = (await res.json()) as
        | { mode: "results-only"; reason: string; results: AskHit[] }
        | { mode: "no-sources" }
        | { error: string };
      if ("mode" in data && data.mode === "results-only") {
        setState({ phase: "results-only", reason: data.reason, results: data.results });
      } else if ("mode" in data && data.mode === "no-sources") {
        setState({ phase: "no-sources" });
      } else {
        setState({
          phase: "error",
          message: "error" in data ? data.error : t("search.ask.failed"),
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : t("search.ask.failed"),
      });
    }
  }

  return (
    <section className="border-border rounded-sm border p-3">
      <h2 className="font-mono text-sm font-medium">{t("search.ask.title")}</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">{t("search.ask.subtitle")}</p>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("question") as HTMLInputElement;
          const question = input.value.trim();
          if (question) void ask(question);
        }}
      >
        <input
          type="text"
          name="question"
          placeholder={t("search.ask.placeholder")}
          className="border-border bg-background focus:border-ring min-w-[16rem] flex-1 rounded-sm border px-3 py-1.5 text-sm outline-none"
        />
        <Button type="submit" variant="outline" size="sm" disabled={state.phase === "loading"}>
          {t("search.ask.submit")}
        </Button>
      </form>

      {state.phase === "loading" ? (
        <p className="text-muted-foreground mt-3 text-sm">{t("search.ask.loading")}</p>
      ) : null}

      {state.phase === "error" ? (
        <p className="border-status-danger/40 bg-status-danger/10 text-status-danger mt-3 rounded-sm border px-3 py-2 text-sm">
          {state.message}
        </p>
      ) : null}

      {state.phase === "no-sources" ? (
        <p className="text-muted-foreground mt-3 text-sm">{t("search.ask.noAnswer")}</p>
      ) : null}

      {state.phase === "results-only" ? (
        <div className="mt-3">
          <p className="text-muted-foreground rounded-sm border border-dashed px-3 py-2 text-sm">
            {state.reason}
          </p>
          <ul className="divide-border mt-1 divide-y">
            {state.results.map((r) => (
              <li key={`${r.sourceType}:${r.sourceId}:${r.ordinal}`} className="px-1 py-2">
                {r.href ? (
                  <Link to={r.href} className="text-sm font-medium hover:underline">
                    {r.title}
                  </Link>
                ) : (
                  <span className="text-sm font-medium">{r.title}</span>
                )}
                <p className="text-muted-foreground text-xs">{r.snippet}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.phase === "streaming" ? (
        <div className="mt-3">
          <div className="flex flex-col gap-2">
            {state.text.split(/\n\s*\n/).map((p, i) => (
              <p key={i} className="text-sm">
                <CitedText text={p} />
              </p>
            ))}
            {!state.text ? (
              <p className="text-muted-foreground text-sm">{t("search.ask.generating")}</p>
            ) : null}
          </div>
          <SourceList sources={state.sources} />
        </div>
      ) : null}

      {state.phase === "done" ? (
        <div className="mt-3">
          <div className="flex flex-col gap-2">
            {!state.validation.ok && !state.validation.noAnswer ? (
              <p className="text-muted-foreground rounded-sm border border-dashed px-3 py-2 text-sm">
                {t("search.ask.noValidCitations")}
              </p>
            ) : (
              state.validation.paragraphs.map((p, i) => (
                <p key={i} className="text-sm">
                  <CitedText text={p.text} />
                  {p.uncited && !state.validation.noAnswer ? (
                    <span className="border-status-warning/40 bg-status-warning/10 text-status-warning ml-2 inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs">
                      {t("search.ask.uncited")}
                    </span>
                  ) : null}
                </p>
              ))
            )}
          </div>
          <SourceList sources={state.sources} />
        </div>
      ) : null}
    </section>
  );
}
