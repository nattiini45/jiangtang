import type * as React from "react";
import { Link } from "react-router";
import { Pin } from "lucide-react";
import { DateCell } from "~/components/data-grid";
import { Badge, badgeClassName } from "~/components/ui/badge";
import { useT } from "~/i18n/use-t";

/**
 * One note row, shared by `/notes` and the project/location panels:
 * title link, tag chips, project chip, author initials, Berlin timestamp and a
 * short plain-text excerpt (markdown marks stripped — `noteExcerpt`).
 */

export interface NoteListItem {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  archivedAt?: Date | null;
  updatedAt: Date;
  author?: { id: string; name: string; initials: string | null };
  project?: { id: string; name: string; slug: string; color: string | null } | null;
}

/** Markdown → plain text, for the list excerpt. Crude on purpose. */
export function noteExcerpt(body: string, max = 140): string {
  const plain = body
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function NoteList({
  notes,
  emptyMessage,
}: {
  notes: NoteListItem[];
  emptyMessage?: React.ReactNode;
}) {
  const t = useT();
  const empty = emptyMessage ?? t("notes.list.emptyDefault");
  if (notes.length === 0) {
    return typeof empty === "string" ? (
      <p className="text-muted-foreground text-sm">{empty}</p>
    ) : (
      <>{empty}</>
    );
  }
  return (
    <ul className="divide-border divide-y">
      {notes.map((note) => (
        <li key={note.id} className="flex flex-col gap-1 py-2">
          <div className="flex items-center gap-2">
            {note.pinned ? (
              <Pin
                className="text-muted-foreground size-3.5 shrink-0"
                aria-label={t("notes.list.pinnedAria")}
                role="img"
              />
            ) : null}
            <Link to={`/notes/${note.id}`} className="hover:underline">
              {note.title}
            </Link>
            {note.tags.map((tag) => (
              <Link
                key={tag}
                to={`/notes?tag=${encodeURIComponent(tag)}`}
                className={`${badgeClassName} hover:bg-tint-hover transition-colors duration-80`}
              >
                {tag}
              </Link>
            ))}
            <span className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
              {note.project ? (
                <Link
                  to={`/projects/${note.project.slug}`}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  <span
                    aria-hidden
                    className="inline-block size-2 rounded-sm"
                    style={{
                      backgroundColor: note.project.color ?? "transparent",
                      border: "1px solid var(--border)",
                    }}
                  />
                  {note.project.name}
                </Link>
              ) : null}
              {note.author ? (
                <Badge className="type-micro h-5 rounded-full px-1.5 font-semibold">
                  {note.author.initials ?? note.author.name}
                </Badge>
              ) : null}
              <DateCell value={note.updatedAt} />
            </span>
          </div>
          {noteExcerpt(note.body) ? (
            <p className="text-muted-foreground truncate text-xs">{noteExcerpt(note.body)}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
