import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { createNote, deleteNote } from "~/domains/notes/notes.mutations.server";
import { importMarkdownNotes } from "~/domains/notes/notes.import.server";
import { noteToMarkdown } from "~/domains/notes/notes.markdown";
import { getNote } from "~/domains/notes/notes.queries.server";

/**
 * The markdown import contract: all-or-nothing in one transaction,
 * per-file errors that name the file, and the export→delete→import restore
 * that keeps the note's id (and therefore its links).
 */

const RUN = `imp_${Date.now().toString(36)}`;
let actor: { id: string; name: string };
const createdIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await db.note.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

async function ensureActor() {
  if (!actor) {
    const u = await db.user.create({
      data: { email: `${RUN}@test.local`, name: RUN, initials: "NI" },
    });
    userIds.push(u.id);
    actor = { id: u.id, name: u.name };
  }
}

describe("importMarkdownNotes", () => {
  it("creates notes from files and reports the count", async () => {
    await ensureActor();
    const result = await importMarkdownNotes(actor, [
      { name: `${RUN}-a.md`, text: `# ${RUN} eins\n\nbody a` },
      {
        name: `${RUN}-b.md`,
        text: `---\ntitle: ${RUN} zwei\ntags: [x]\npinned: true\n---\n\nbody b`,
      },
    ]);
    expect(result).toEqual({ created: 2, updated: 0 });
    const mine = await db.note.findMany({ where: { title: { startsWith: RUN } } });
    createdIds.push(...mine.map((n) => n.id));
    expect(mine).toHaveLength(2);
    const b = mine.find((n) => n.title === `${RUN} zwei`)!;
    expect(b.tags).toEqual(["x"]);
    expect(b.pinned).toBe(true);
    expect(b.authorId).toBe(actor.id);
  });

  it("a front-matter id that exists UPDATES that note (audit updated:true)", async () => {
    await ensureActor();
    const note = await createNote(actor, {
      title: `${RUN} upd`,
      body: "alt",
      pinned: false,
      tags: [],
      projectId: undefined,
      locationId: undefined,
    });
    createdIds.push(note.id);
    const result = await importMarkdownNotes(actor, [
      { name: "x.md", text: `---\nid: ${note.id}\ntitle: ${RUN} upd\n---\n\nneu` },
    ]);
    expect(result).toEqual({ created: 0, updated: 1 });
    const after = await getNote(note.id);
    expect(after?.body).toBe("neu");
    // An editor still open on the pre-import text must hit a conflict, not overwrite it.
    expect(after?.version).toBe(note.version + 1);
    const rows = await db.activityLog.findMany({
      where: { entityType: "note", entityId: note.id },
      orderBy: [{ insertedAt: "asc" }, { id: "asc" }],
    });
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated", "NoteImported"]);
    expect((rows[1].data as { updated: boolean }).updated).toBe(true);
  });

  it("honours a cuid-shaped free id — and ignores a non-cuid-shaped one", async () => {
    await ensureActor();
    const shaped = "zzzz1111aaaa2222"; // /^[a-z0-9]{8,40}$/i
    const weird = "not a real id!";
    const result = await importMarkdownNotes(actor, [
      { name: `${RUN}-shaped.md`, text: `---\nid: ${shaped}\ntitle: ${RUN} shaped\n---\n\nx` },
      { name: `${RUN}-weird.md`, text: `---\nid: "${weird}"\ntitle: ${RUN} weird\n---\n\nx` },
    ]);
    expect(result).toEqual({ created: 2, updated: 0 });
    const shapedNote = await db.note.findUnique({ where: { id: shaped } });
    expect(shapedNote?.title).toBe(`${RUN} shaped`);
    createdIds.push(shaped);
    // The weird id must not become the primary key — a fresh cuid was minted.
    const weirdNote = await db.note.findFirst({ where: { title: `${RUN} weird` } });
    expect(weirdNote).not.toBeNull();
    expect(weirdNote!.id).not.toBe(weird);
    createdIds.push(weirdNote!.id);
  });

  it("export → delete → import restores the same id (links intact)", async () => {
    await ensureActor();
    const project = await db.project.findFirst({ select: { id: true, slug: true } });
    const note = await createNote(actor, {
      title: `${RUN} restore`,
      body: "mit Inhalt",
      pinned: true,
      tags: ["r"],
      projectId: project?.id,
      locationId: undefined,
    });
    const md = noteToMarkdown({ ...note, project: project ? { slug: project.slug } : null });
    await deleteNote(actor, note.id);
    expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
    const result = await importMarkdownNotes(actor, [{ name: "restore.md", text: md }]);
    expect(result).toEqual({ created: 1, updated: 0 });
    const restored = await getNote(note.id);
    expect(restored).not.toBeNull();
    expect(restored!.title).toBe(`${RUN} restore`);
    expect(restored!.body).toBe("mit Inhalt");
    expect(restored!.pinned).toBe(true);
    expect(restored!.tags).toEqual(["r"]);
    expect(restored!.project?.slug).toBe(project?.slug);
    createdIds.push(note.id);
  });

  it("an empty file aborts the WHOLE batch — nothing survives", async () => {
    await ensureActor();
    await expect(
      importMarkdownNotes(actor, [
        { name: `${RUN}-ok.md`, text: `# ${RUN} ok\n\nfine` },
        { name: `${RUN}-empty.md`, text: "   " },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.note.count({ where: { title: `${RUN} ok` } })).toBe(0);
  });

  it("an unknown project slug is a per-file error that names the file", async () => {
    await ensureActor();
    await expect(
      importMarkdownNotes(actor, [
        { name: `${RUN}-bad.md`, text: `---\ntitle: x\nproject: nicht-da\n---\n\nbody` },
      ]),
    ).rejects.toMatchObject({ formErrors: [expect.stringContaining(`${RUN}-bad.md`)] });
  });

  it("an unknown location id is a per-file error", async () => {
    await ensureActor();
    await expect(
      importMarkdownNotes(actor, [
        { name: `${RUN}-loc.md`, text: `---\ntitle: x\nlocation: noloc123\n---\n\nbody` },
      ]),
    ).rejects.toMatchObject({ formErrors: [expect.stringContaining("noloc123")] });
  });
});
