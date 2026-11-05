import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Note ⇄ Markdown — pure and client-safe. The export format is YAML
 * front-matter over the raw body, exactly:
 *
 *     ---
 *     id: <cuid>
 *     title: <string>
 *     tags: [a, b]        # YAML list
 *     pinned: true
 *     project: <slug>     # omitted when unset
 *     location: <id>      # omitted when unset
 *     created: <ISO>
 *     updated: <ISO>
 *     ---
 *     <blank line>
 *     <body, verbatim>
 *
 * `parse(export(note))` reproduces title, body, tags, pinned, project
 * byte-for-byte: the exporter writes exactly ONE blank line between the
 * closing fence and the body, and the parser strips exactly that one — a body
 * that itself starts with blank lines keeps them all.
 */

/** The note shape the exporter needs — a `Note` row plus its project slug. */
export interface MarkdownNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  project?: { slug: string } | null;
  locationId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function noteToMarkdown(note: MarkdownNote): string {
  const frontMatter: Record<string, unknown> = {
    id: note.id,
    title: note.title,
    tags: note.tags,
    pinned: note.pinned,
  };
  if (note.project) frontMatter.project = note.project.slug;
  if (note.locationId) frontMatter.location = note.locationId;
  frontMatter.created = note.createdAt.toISOString();
  frontMatter.updated = note.updatedAt.toISOString();
  return `---\n${stringifyYaml(frontMatter)}---\n\n${note.body}`;
}

/** An unsaved editor draft, as the conflict notice offers it for download. */
export interface MarkdownDraft {
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  projectSlug?: string;
  locationId?: string;
}

/**
 * The export format without `id` (and without timestamps): importing the file
 * creates a new note instead of overwriting the one it was drafted against.
 */
export function draftToMarkdown(draft: MarkdownDraft): string {
  const frontMatter: Record<string, unknown> = {
    title: draft.title,
    tags: draft.tags,
    pinned: draft.pinned,
  };
  if (draft.projectSlug) frontMatter.project = draft.projectSlug;
  if (draft.locationId) frontMatter.location = draft.locationId;
  return `---\n${stringifyYaml(frontMatter)}---\n\n${draft.body}`;
}

export interface ParsedMarkdownNote {
  id?: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  projectSlug?: string;
  locationId?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return [...new Set(v.map((t) => String(t).trim()).filter((t) => t !== ""))];
  }
  if (typeof v === "string") {
    return [
      ...new Set(
        v
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t !== ""),
      ),
    ];
  }
  return [];
}

export function parseMarkdownNote(filename: string, text: string): ParsedMarkdownNote {
  // Normalise CRLF up front — a Windows-edited file must not smuggle `\r` into
  // bodies or break the fence regexes.
  const normalized = text.replace(/\r\n?/g, "\n");
  let body = normalized;
  let frontMatter: Record<string, unknown> = {};

  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (match) {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontMatter = parsed as Record<string, unknown>;
    }
    body = normalized.slice(match[0].length);
    if (body.startsWith("\n")) body = body.slice(1); // the exporter's one blank line
  }

  const heading = /^#[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
  const title = str(frontMatter.title) ?? heading ?? filename.replace(/\.md$/i, "");

  return {
    id: str(frontMatter.id),
    title,
    body,
    tags: parseTags(frontMatter.tags),
    pinned: frontMatter.pinned === true || frontMatter.pinned === "true",
    projectSlug: str(frontMatter.project),
    locationId: str(frontMatter.location),
  };
}
