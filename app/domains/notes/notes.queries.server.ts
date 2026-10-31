import { tr } from "~/i18n/request-locale.server";
import type { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import type { NoteListOptions } from "./notes.schema";

/**
 * Notes-domain queries. Reads only — every mutating caller opens its own
 * transaction through `txWithAudit`.
 */

const NOTE_INCLUDE = {
  author: { select: { id: true, name: true, initials: true } },
  project: { select: { id: true, name: true, slug: true, color: true } },
  location: { select: { id: true, name: true } },
} as const;

function noteWhere(options: NoteListOptions): Prisma.NoteWhereInput {
  const archived = options.archived ?? "exclude";
  return {
    ...(archived === "exclude"
      ? { archivedAt: null }
      : archived === "only"
        ? { archivedAt: { not: null } }
        : {}),
    ...(options.q
      ? {
          OR: [
            { title: { contains: options.q, mode: "insensitive" as const } },
            { body: { contains: options.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(options.tag ? { tags: { has: options.tag } } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.locationId ? { locationId: options.locationId } : {}),
  };
}

/**
 * `listNotes` — the `/notes` read: pinned first, then most recently touched.
 * `archived` defaults to `"exclude"`; `"only"` and `"include"` back the
 * archived filter.
 */
export async function listNotes(options: NoteListOptions = {}) {
  return db.note.findMany({
    where: noteWhere(options),
    include: NOTE_INCLUDE,
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
  });
}

/** `getNote(id)` — the detail/editor read. */
export async function getNote(id: string) {
  return db.note.findUnique({ where: { id }, include: NOTE_INCLUDE });
}

/** Like {@link getNote} but throws — for mutations that refuse a missing row. */
export async function requireNote(id: string) {
  const note = await db.note.findUnique({ where: { id } });
  if (!note) throw new NotFoundError(tr("work.err.note.notFound"));
  return note;
}

/**
 * `listNoteTags` — distinct tags with their note counts, for the filter chips
 * on `/notes`. Counts every note, archived included: a chip names a tag, not a
 * filter result — which slice of it is visible is the `archived` filter's call.
 * `unnest` because `tags` is `String[]`, not a table.
 */
export async function listNoteTags(): Promise<Array<{ tag: string; count: number }>> {
  const rows = await db.$queryRaw<Array<{ tag: string; count: bigint }>>`
    SELECT tag, count(*)::bigint AS count
    FROM "Note", unnest("tags") AS tag
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
