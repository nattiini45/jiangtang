import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import {
  archiveNote,
  createNote,
  deleteNote,
  setNotePinned,
  unarchiveNote,
  updateNote,
} from "~/domains/notes/notes.mutations.server";
import { getNote, listNotes, listNoteTags } from "~/domains/notes/notes.queries.server";
import type { NoteCreateInput } from "~/domains/notes/notes.schema";
import { noteCreateSchema } from "~/domains/notes/notes.schema";

/**
 * Notes-domain tests, the `tasks.test.ts` shape one folder over:
 * every mutation through `txWithAudit`, every refusal writes nothing — and
 * `updateNote`'s autosave-shaped no-op writes nothing either.
 * ActivityLog is append-only; assertions are scoped to ids this file created.
 */

const RUN = `note_${Date.now().toString(36)}`;
let author: { id: string; name: string; initials: string };
const createdIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await db.note.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: { email: `${RUN}-${tag}@test.local`, name: `${RUN} ${tag}`, initials: "NT" },
  });
  userIds.push(user.id);
  return user;
}

function input(over: Partial<NoteCreateInput> & { title: string }): NoteCreateInput {
  return {
    body: "",
    pinned: false,
    tags: [],
    projectId: undefined,
    locationId: undefined,
    ...over,
  };
}

async function make(over: Partial<NoteCreateInput> & { title: string }) {
  const note = await createNote(author, input(over));
  createdIds.push(note.id);
  return note;
}

function auditFor(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "note", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

async function ensureAuthor() {
  if (!author) {
    const u = await makeUser("author");
    author = { id: u.id, name: u.name, initials: u.initials ?? "NT" };
  }
}

describe("notes domain", () => {
  it("creates a note with the actor as author and audits it", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} erstes`, tags: ["a", "b"], body: "Hallo" });
    expect(note.authorId).toBe(author.id);
    expect(note.body).toBe("Hallo");
    const rows = await auditFor(note.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated"]);
    expect(rows[0].actorId).toBe(author.id);
  });

  it("refuses to create without an actor id — nothing written, no audit", async () => {
    await expect(
      createNote({ id: null, name: "Anon" }, input({ title: `${RUN} anonym` })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses unknown project/location refs as field errors — no write, no audit", async () => {
    await ensureAuthor();
    await expect(
      createNote(author, input({ title: `${RUN} badref`, projectId: "nope" })),
    ).rejects.toMatchObject({ fieldErrors: { projectId: expect.any(Array) } });
    const mine = await db.note.findMany({ where: { title: `${RUN} badref` } });
    expect(mine).toHaveLength(0);
  });

  it("updateNote with identical values writes NOTHING — no audit row (the autosave case)", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} no-op`, body: "x" });
    const again = await updateNote(author, note.id, input({ title: `${RUN} no-op`, body: "x" }));
    expect(again.body).toBe("x");
    const rows = await auditFor(note.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated"]);
  });

  it("updateNote audits only the changed field NAMES — never the body text", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} diff`, body: "geheim alt" });
    await updateNote(
      author,
      note.id,
      input({ title: `${RUN} diff`, body: "geheim neu", pinned: true }),
    );
    const rows = await auditFor(note.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].action).toBe("NoteUpdated");
    const data = rows[1].data as { fields: string[] };
    expect(data.fields.sort()).toEqual(["body", "pinned"]);
    expect(JSON.stringify(data)).not.toContain("geheim neu");
    expect(JSON.stringify(data)).not.toContain("geheim alt");
  });

  it("pin/unpin writes the matching verbs; re-pin is a no-op", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} pin` });
    await setNotePinned(author, note.id, true);
    await setNotePinned(author, note.id, true); // already pinned → silent no-op
    await setNotePinned(author, note.id, false);
    const rows = await auditFor(note.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated", "NotePinned", "NoteUnpinned"]);
  });

  it("archive/unarchive toggle archivedAt and the list filter honours it", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} arch` });
    await archiveNote(author, note.id);
    expect((await db.note.findUniqueOrThrow({ where: { id: note.id } })).archivedAt).not.toBeNull();
    const ids = (await listNotes()).map((n) => n.id);
    expect(ids).not.toContain(note.id);
    const archivedIds = (await listNotes({ archived: "only" })).map((n) => n.id);
    expect(archivedIds).toContain(note.id);
    const allIds = (await listNotes({ archived: "include" })).map((n) => n.id);
    expect(allIds).toContain(note.id);
    // double archive is a refusal, not a silent rewrite
    await expect(archiveNote(author, note.id)).rejects.toBeInstanceOf(ValidationError);
    await unarchiveNote(author, note.id);
    expect((await db.note.findUniqueOrThrow({ where: { id: note.id } })).archivedAt).toBeNull();
    const rows = await auditFor(note.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated", "NoteArchived", "NoteUnarchived"]);
  });

  it("listNotes: pinned first, q matches title or body, tag/project filters", async () => {
    await ensureAuthor();
    const low = await make({ title: `${RUN} unpinned`, body: "qqneedle" });
    const high = await make({ title: `${RUN} gepinnt`, pinned: true });
    const tagged = await make({ title: `${RUN} tagged`, tags: [`${RUN}-tag`] });
    const all = await listNotes({ q: RUN });
    expect(all.map((n) => n.id)).toEqual(expect.arrayContaining([high.id, low.id, tagged.id]));
    expect(all[0].id).toBe(high.id); // pinned first, then updatedAt desc
    const qHit = await listNotes({ q: "qqneedle" });
    expect(qHit.map((n) => n.id)).toContain(low.id);
    const tagHit = await listNotes({ tag: `${RUN}-tag` });
    expect(tagHit.map((n) => n.id)).toEqual([tagged.id]);
  });

  it("listNoteTags returns distinct tags with counts", async () => {
    await ensureAuthor();
    await make({ title: `${RUN} t1`, tags: [`${RUN}x`, `${RUN}y`] });
    await make({ title: `${RUN} t2`, tags: [`${RUN}x`] });
    const tags = await listNoteTags();
    expect(tags.find((t) => t.tag === `${RUN}x`)?.count).toBeGreaterThanOrEqual(2);
    expect(tags.find((t) => t.tag === `${RUN}y`)?.count).toBeGreaterThanOrEqual(1);
  });

  it("getNote carries author, project and location", async () => {
    await ensureAuthor();
    const project = await db.project.findFirst({ select: { id: true } });
    const note = await make({ title: `${RUN} get`, projectId: project?.id });
    const loaded = await getNote(note.id);
    expect(loaded?.author.id).toBe(author.id);
    expect(loaded?.project?.slug).toBeTruthy();
    createdIds.push(note.id);
  });

  it("deleteNote audits the title; deleting a missing note refuses", async () => {
    await ensureAuthor();
    const note = await make({ title: `${RUN} del` });
    await deleteNote(author, note.id);
    createdIds.splice(createdIds.indexOf(note.id), 1);
    const rows = await auditFor(note.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated", "NoteDeleted"]);
    expect((rows[1].data as { title: string }).title).toBe(`${RUN} del`);
    await expect(deleteNote(author, note.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("clientId makes createNote idempotent — same row, ONE audit entry", async () => {
    await ensureAuthor();
    const clientId = `c${RUN.replace(/[^a-z0-9]/g, "")}note1`.padEnd(25, "0").slice(0, 25);
    const first = await createNote(author, input({ title: `${RUN} idem` }), clientId);
    createdIds.push(first.id);
    expect(first.id).toBe(clientId);
    const second = await createNote(author, input({ title: `${RUN} idem (doppelt)` }), clientId);
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title); // the replay keeps the FIRST row
    expect(await auditFor(clientId)).toHaveLength(1);
  });

  it("a malformed clientId is refused, not silently stored", async () => {
    await ensureAuthor();
    await expect(
      createNote(author, input({ title: `${RUN} badid` }), "not-a-cuid"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("noteCreateSchema", () => {
  it("absent body normalises to the empty string — the NOT NULL column's shape", () => {
    const parsed = noteCreateSchema.safeParse({ title: "x" });
    expect(parsed.success && parsed.data.body).toBe("");
  });

  it("one blank tag input can never reject the save", () => {
    const parsed = noteCreateSchema.safeParse({ title: "x", tags: ["  ", "a", "a", ""] });
    expect(parsed.success && parsed.data.tags).toEqual(["a"]);
  });

  it("checkbox values and booleans both parse for pinned", () => {
    expect(noteCreateSchema.safeParse({ title: "x", pinned: "on" }).data?.pinned).toBe(true);
    expect(noteCreateSchema.safeParse({ title: "x" }).data?.pinned).toBe(false);
  });
});
