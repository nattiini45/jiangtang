import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  createNote,
  deleteNote,
  setNotePinned,
  updateNote,
} from "~/domains/notes/notes.mutations.server";
import { getNote } from "~/domains/notes/notes.queries.server";
import { noteToMarkdown } from "~/domains/notes/notes.markdown";
import { importMarkdownNotes } from "~/domains/notes/notes.import.server";

/**
 * Exit — the notes lifecycle composed end to end through the domain API:
 * create → edit → pin → tag → export → delete → re-import, and the
 * note that comes back is the note that left: title, body, tags, pinned —
 * and its ID, because the exporter keeps it and the importer restores by it.
 */
const RUN = `notesexit_${Date.now().toString(36)}`;
const userIds: string[] = [];
const noteIds: string[] = [];

afterAll(async () => {
  for (const id of [...noteIds].reverse()) {
    await db.note.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("notes exit — note create→edit→pin→tag→export→delete→reimport", () => {
  it("round-trips the whole lifecycle", async () => {
    const user = await db.user.create({
      data: { email: `${RUN}@test.local`, name: RUN, initials: "NX" },
    });
    userIds.push(user.id);
    const actor = { id: user.id, name: user.name, initials: user.initials };

    const note = await createNote(actor, {
      title: `${RUN} notiz`,
      body: "roh",
      pinned: false,
      tags: [],
      projectId: undefined,
      locationId: undefined,
    });
    noteIds.push(note.id);

    await updateNote(actor, note.id, {
      title: `${RUN} notiz`,
      body: "# Überschrift\n\nMit **Markdown** und Ümläuten\n\n```\ncode\n```",
      pinned: false,
      tags: ["protokoll", "übung"],
      projectId: undefined,
      locationId: undefined,
    });
    await setNotePinned(actor, note.id, true);

    const before = await getNote(note.id);
    const md = noteToMarkdown({ ...before!, project: before!.project });
    expect(md).toContain("protokoll");

    await deleteNote(actor, note.id);
    expect(await getNote(note.id)).toBeNull();

    const result = await importMarkdownNotes(actor, [{ name: "export.md", text: md }]);
    expect(result).toEqual({ created: 1, updated: 0 });

    const after = await getNote(note.id);
    expect(after).not.toBeNull();
    expect(after!.title).toBe(`${RUN} notiz`);
    expect(after!.body).toBe(before!.body);
    expect(after!.tags).toEqual(["protokoll", "übung"]);
    expect(after!.pinned).toBe(true);
    expect(after!.id).toBe(note.id);
  });
});
