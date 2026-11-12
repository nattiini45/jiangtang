/**
 * Ask (stages 4–6 of the retrieval pipeline): context assembly, the verbatim
 * system prompt, and answer validation. The generation provider streams; this
 * module owns everything around the stream — which chunks become sources, how
 * the prompt is built, and whether the answer's `[n]` citations are honest.
 */
import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { workspaceLocale } from "~/i18n/locale.server";
import { LOCALES, type Locale } from "~/i18n/locales";
import { sourceTypeLabel, searchAnchor } from "./labels";
import type { SearchHit } from "./query.server";
import type { ChatMessage } from "~/lib/ai/types";
import { readAiConfig } from "~/lib/ai/config.server";

/** The no-answer sentence the model must emit verbatim when sources don't answer. */
export function noAnswer(locale: Locale = workspaceLocale()): string {
  return t(locale, "search.ask.noAnswer");
}

/**
 * The system prompt — VERBATIM per language, do not reword (the citation
 * discipline is load-bearing). `{sources}` is replaced by the formatted source
 * list. The prompt follows the workspace language; the model still answers in
 * the language of the question.
 */
export function askSystemPrompt(locale: Locale = workspaceLocale()): string {
  return t(locale, "search.ask.systemPrompt");
}
export interface AskSource {
  n: number;
  sourceType: string;
  sourceId: string;
  ordinal: number;
  title: string;
  headingPath: string[];
  text: string;
  href: string | null;
  anchor: string;
}

const PER_SOURCE_CHARS = 1500;
const TOTAL_CONTEXT_CHARS = 12_000;

/**
 * Numbered sources `[1]…[n]` from the top hits: the cited chunk plus up to two
 * more chunks of the same source (its heading path labels the section), each
 * source capped at 1500 chars and the whole context at 12 000.
 */
export async function buildAskContext(hits: SearchHit[]): Promise<AskSource[]> {
  const top = hits.slice(0, 8);
  if (!top.length) return [];

  const clauses = top.flatMap((h) =>
    [h.ordinal, ...h.moreOrdinals].map(
      (ordinal) =>
        Prisma.sql`("sourceType" = ${h.sourceType} AND "sourceId" = ${h.sourceId} AND ordinal = ${ordinal})`,
    ),
  );
  const rows = await db.$queryRaw<
    { sourceType: string; sourceId: string; ordinal: number; headingPath: string[]; text: string }[]
  >`SELECT "sourceType", "sourceId", ordinal, "headingPath", text
    FROM "Chunk" WHERE ${Prisma.join(clauses, " OR ")}
    ORDER BY "sourceType", "sourceId", ordinal`;

  const key = (r: { sourceType: string; sourceId: string; ordinal: number }) =>
    `${r.sourceType}:${r.sourceId}:${r.ordinal}`;
  const byKey = new Map(rows.map((r) => [key(r), r]));

  let total = 0;
  const sources: AskSource[] = [];
  for (const [i, h] of top.entries()) {
    const ordinals = [h.ordinal, ...h.moreOrdinals];
    const parts: string[] = [];
    let headingPath: string[] = [];
    for (const ord of ordinals) {
      const row = byKey.get(key({ sourceType: h.sourceType, sourceId: h.sourceId, ordinal: ord }));
      if (!row) continue;
      if (ord === h.ordinal) headingPath = row.headingPath;
      parts.push(row.text);
    }
    if (!parts.length) continue;
    let text = parts.join("\n\n");
    if (text.length > PER_SOURCE_CHARS) text = `${text.slice(0, PER_SOURCE_CHARS - 1)}…`;
    if (total + text.length > TOTAL_CONTEXT_CHARS) {
      const room = TOTAL_CONTEXT_CHARS - total;
      if (room < 200) break; // a sliver of a source cites worse than none
      text = `${text.slice(0, room - 1)}…`;
    }
    total += text.length;
    sources.push({
      n: i + 1,
      sourceType: h.sourceType,
      sourceId: h.sourceId,
      ordinal: h.ordinal,
      title: h.title,
      headingPath,
      text,
      href: h.href,
      anchor: searchAnchor(h.sourceType, h.sourceId, h.ordinal),
    });
  }
  return sources;
}

function formatSources(sources: AskSource[], locale: Locale): string {
  return sources
    .map((s) => {
      const path = s.headingPath.length ? ` › ${s.headingPath.join(" › ")}` : "";
      return `[${s.n}] ${sourceTypeLabel(locale, s.sourceType)}: ${s.title}${path}\n${s.text}`;
    })
    .join("\n\n");
}

export type AskSystemRole = "system" | "merge";

/** The configured mode for the live provider (route-side; tests pass it in). */
export function askSystemRole(): AskSystemRole {
  const cfg = readAiConfig();
  return cfg.generation.state === "api" ? cfg.generation.config.systemRole : "system";
}

/**
 * `[system: prompt, user: question]` — under `merge` the system text is folded
 * into the first user message (older Mistral templates reject a system role).
 */
export function buildAskMessages(
  question: string,
  sources: AskSource[],
  systemRole: AskSystemRole = "system",
  locale: Locale = workspaceLocale(),
): ChatMessage[] {
  const system = askSystemPrompt(locale).replace("{sources}", formatSources(sources, locale));
  if (systemRole === "merge") {
    return [{ role: "user", content: `${system}\n\n${question}` }];
  }
  return [
    { role: "system", content: system },
    { role: "user", content: question },
  ];
}

export interface ValidatedParagraph {
  text: string;
  citations: number[];
  uncited: boolean;
}

export interface AnswerValidation {
  paragraphs: ValidatedParagraph[];
  invalidCitations: number[];
  noAnswer: boolean;
  ok: boolean;
}

const CITATION = /\[(\d{1,2})\]/g;

/**
 * Citation check: every paragraph must carry at least one valid `[k]`
 * (1..n); invalid markers are stripped from the displayed text. `ok` is
 * `noAnswer` OR (≥1 valid citation AND zero uncited paragraphs).
 */
export function validateAnswer(text: string, n: number): AnswerValidation {
  const trimmed = text.trim();
  const unquoted = trimmed.replace(/^[„“”"'‘’]+|[„“”"'‘’]+$/g, "");
  const isNoAnswer = LOCALES.some((l) => unquoted === noAnswer(l));

  const invalidCitations: number[] = [];
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const citations: number[] = [];
      const cleaned = p
        .replace(CITATION, (match, k: string) => {
          const num = Number.parseInt(k, 10);
          if (num >= 1 && num <= n) {
            citations.push(num);
            return match;
          }
          invalidCitations.push(num);
          return "";
        })
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .trim();
      return { text: cleaned, citations, uncited: citations.length === 0 };
    });

  const ok =
    isNoAnswer ||
    (paragraphs.some((p) => p.citations.length > 0) && paragraphs.every((p) => !p.uncited));
  return { paragraphs, invalidCitations, noAnswer: isNoAnswer, ok };
}
