import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getAi } from "~/lib/ai/registry.server";
import { hybridSearch } from "~/lib/search/query.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import {
  buildAskContext,
  buildAskMessages,
  validateAnswer,
  askSystemRole,
} from "~/lib/search/ask.server";

/**
 * Ask route: POST { question } → retrieval → streamed, cited answer.
 *
 * Response modes: `results-only` (no generation provider — cite the hits
 * instead), `no-sources` (nothing matched), or `text/event-stream` with
 * `sources` → `delta`… → `done`/`error` events. One in-flight ask per user;
 * a second concurrent request gets 429.
 */

const inflight = new Set<string>();

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const locale = resolveLocale(request);

  let body: { question?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: t(locale, "err.ask.invalidRequest") }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return Response.json({ error: t(locale, "err.ask.questionRequired") }, { status: 400 });
  }

  if (inflight.has(user.id)) {
    return Response.json({ error: t(locale, "err.ask.inFlight") }, { status: 429 });
  }

  const { results } = await hybridSearch(question, { limit: 8 });
  const generation = getAi().generation;
  if (!generation) {
    return Response.json({
      mode: "results-only",
      reason: t(locale, "err.ask.resultsOnlyReason"),
      results,
    });
  }
  if (!results.length) {
    return Response.json({ mode: "no-sources" });
  }

  // has→add with no await between them is atomic in a single-threaded server —
  // the early check above is the fast path, this one closes the race window.
  if (inflight.has(user.id)) {
    return Response.json({ error: t(locale, "err.ask.inFlight") }, { status: 429 });
  }
  inflight.add(user.id);
  const sources = await buildAskContext(results);
  const messages = buildAskMessages(question, sources, askSystemRole());
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));
      try {
        send(
          "sources",
          sources.map((s) => ({
            n: s.n,
            title: s.title,
            href: s.href,
            anchor: s.anchor,
            sourceType: s.sourceType,
          })),
        );
        let answer = "";
        for await (const delta of generation.generate(messages)) {
          if (request.signal.aborted) break;
          answer += delta;
          send("delta", delta);
        }
        if (!request.signal.aborted) {
          send("done", validateAnswer(answer, sources.length));
        }
      } catch (err) {
        console.error("[api.ask] generation failed:", err);
        if (!request.signal.aborted) {
          send("error", { message: t(locale, "err.ask.generationFailed") });
        }
      } finally {
        inflight.delete(user.id);
        controller.close();
      }
    },
    cancel() {
      inflight.delete(user.id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
