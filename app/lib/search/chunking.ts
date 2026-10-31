/**
 * Chunk construction for the search index — pure,
 * client-safe, no I/O.
 *
 * `chunkMarkdown` is heading-aware: every emitted section carries the trail of
 * `#`-headings it sits under, and a section longer than `max` is split on
 * paragraph boundaries (falling back to a word boundary, never mid-word).
 *
 * `identifierVariants` derives the `keywords` column content: the forms of an
 * identifier the `simple`/`german` tokenisers would split apart, so a query for
 * "ersatzteile" finds "ersatzteile@demo-ersatzteile.example".
 *
 * `prepareChunk` builds the full row both the indexer and the retrieval eval use —
 * one canonical `contentHash` (sha256 of `title + "\n" + text`) decides whether
 * an edit actually changed the text.
 */
import { createHash } from "node:crypto";

export interface ChunkSection {
  /** The `#`-heading trail this section sits under (outermost first). */
  headingPath: string[];
  text: string;
}

export interface ChunkOptions {
  /** Soft target for merged short sections. */
  target?: number;
  /** Hard ceiling — a section longer than this is split. */
  max?: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Split one over-long section on paragraph boundaries, then word boundaries. */
function splitLong(section: ChunkSection, max: number): ChunkSection[] {
  if (section.text.length <= max) return [section];
  const out: ChunkSection[] = [];
  let rest = section.text;
  while (rest.length > max) {
    // Prefer the last paragraph break inside the window…
    let cut = rest.lastIndexOf("\n\n", max);
    // …then the last whitespace (never mid-word)…
    if (cut < 0) {
      for (let i = max; i > 0; i--) {
        if (/\s/.test(rest[i]!)) {
          cut = i;
          break;
        }
      }
    }
    // …and only cut a single word longer than `max` as the last resort.
    if (cut <= 0) cut = max;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push({ headingPath: section.headingPath, text: piece });
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push({ headingPath: section.headingPath, text: rest });
  return out;
}

export function chunkMarkdown(text: string, opts: ChunkOptions = {}): ChunkSection[] {
  const { target = 1200, max = 2000 } = opts;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const sections: ChunkSection[] = [];
  const trail: string[] = []; // trail[level - 1] = the current heading at that level
  let sectionTrail: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const t = buf.join("\n").trim();
    buf = [];
    if (t) sections.push({ headingPath: sectionTrail, text: t });
  };

  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      trail[level - 1] = m[2]!.trim();
      trail.length = level;
      sectionTrail = trail.filter(Boolean).slice();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();

  // Merge adjacent sections that share a heading trail until `target` — a doc
  // of many tiny sections should not shard into one-word chunks.
  const merged: ChunkSection[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.text.length + s.text.length + 2 <= target &&
      prev.headingPath.join("") === s.headingPath.join("")
    ) {
      prev.text = `${prev.text}\n\n${s.text}`;
    } else {
      merged.push({ headingPath: s.headingPath, text: s.text });
    }
  }

  return merged.flatMap((s) => splitLong(s, max));
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const MAC = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
/** Dotted codes with a leading letter: D.01.01, D.02.03 (IPv4 is its own rule). */
const DOTTED = /\b[A-Za-z]+\d*(?:\.[A-Za-z0-9]+)+\b/g;
/** Hyphen/underscore identifiers carrying at least one digit: SN-ULX-0001, CAB-HDMI-10, INV-2024-015. */
const HYPHENATED = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g;

/**
 * Extra tokens for the `keywords` column — the spellings under which an
 * identifier should also be findable. Every emitted variant is what a person
 * would plausibly type into the box.
 */
export function identifierVariants(text: string): string[] {
  const out = new Set<string>();

  for (const m of text.matchAll(EMAIL)) {
    const [local = "", domain = ""] = m[0].split("@");
    out.add(local);
    out.add(domain);
    for (const label of domain.split(".")) out.add(label);
  }

  for (const m of text.matchAll(IPV4)) {
    for (const octet of m[0].split(".")) out.add(octet);
    out.add(m[0].replace(/\./g, ""));
  }

  for (const m of text.matchAll(MAC)) {
    out.add(m[0].replace(/[:-]/g, ""));
  }

  for (const m of text.matchAll(DOTTED)) {
    out.add(m[0].replace(/\./g, ""));
    for (const part of m[0].split(".")) out.add(part);
  }

  for (const m of text.matchAll(HYPHENATED)) {
    if (!/\d/.test(m[0])) continue; // a plain hyphenated word is not an identifier
    out.add(m[0].replace(/-/g, ""));
  }

  return [...out];
}

export interface PreparedChunk {
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  keywords: string;
  tokenCount: number;
  contentHash: string;
  sourceUpdatedAt: Date;
}

/**
 * The one place a Chunk row is assembled — indexer and eval share it so the
 * hash, the keywords and the token estimate can never diverge.
 */
export function prepareChunk(input: {
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  sourceUpdatedAt: Date;
}): PreparedChunk {
  return {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceTitle: input.sourceTitle,
    ordinal: input.ordinal,
    headingPath: input.headingPath,
    text: input.text,
    keywords: identifierVariants(`${input.sourceTitle}\n${input.text}`).join(" "),
    tokenCount: Math.ceil(input.text.length / 4),
    contentHash: createHash("sha256").update(`${input.sourceTitle}\n${input.text}`).digest("hex"),
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}
