import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for the `/notes*` routes and the `.md` export/import
 * — the `tasks-routes.test.ts` shape, one surface over.
 *
 * ⚠️ Not a render test: loaders/actions are called directly against the real
 * dev database. The editor's DOM half (debounce, slash row) is covered by the
 * pure-function tests in `app/components/notes/__tests__/`.
 */
const RUN = `notes_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Notes Tester",
  email: `${RUN}@test.local`,
  initials: "NT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

const indexRoute = await import("~/routes/_desktop.notes._index/route");
const newRoute = await import("~/routes/_desktop.notes.new/route");
const detailRoute = await import("~/routes/_desktop.notes.$id/route");
const importRoute = await import("~/routes/_desktop.notes.import/route");
const exportRoute = await import("~/routes/notes.$id.export/route");

const noteIds: string[] = [];
const userIds: string[] = [];

const post = (url: string, body: Record<string, string | string[] | File | File[]>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    for (const one of Array.isArray(v) ? v : [v]) form.append(k, one as string | Blob);
  }
  return new Request(url, { method: "POST", body: form });
};

const postDetail = (id: string, body: Record<string, string | string[]>) =>
  detailRoute.action({
    request: post(`http://localhost/notes/${id}`, body),
    params: { id },
  } as never);

const postNew = (body: Record<string, string | string[]>) =>
  newRoute.action({ request: post("http://localhost/notes/new", body) } as never);

const loadIndex = async (query = "") =>
  (await indexRoute.loader({
    request: new Request(`http://localhost/notes${query}`),
  } as never)) as {
    notes: Array<{ id: string; title: string; pinned: boolean; archivedAt: unknown }>;
  };

const auditFor = (id: string) =>
  db.activityLog.findMany({
    where: { entityType: "note", entityId: id },
    orderBy: { occurredAt: "asc" },
  });

/** Creates a note through the REAL route action — the full post path. */
async function makeNote(over: Record<string, string | string[]> = {}) {
  const res = await postNew({ title: `${RUN} note`, ...over });
  if (!(res instanceof Response))
    throw new Error(`create did not redirect: ${JSON.stringify(res)}`);
  const id = res.headers.get("location")!.split("/").pop()!;
  noteIds.push(id);
  return db.note.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  // createNote refuses an id-less actor — the mocked requireUser therefore
  // carries a REAL user row, not the null-id stub the tasks tests use.
  const user = await db.user.create({
    data: { email: TEST_USER.email!, name: TEST_USER.name!, initials: "NT" },
  });
  userIds.push(user.id);
  TEST_USER.id = user.id;
});

afterAll(async () => {
  for (const id of [...noteIds].reverse()) {
    await db.note.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("/notes — loader filters", () => {
  it("q, tag and archived filter; garbage project degrades to unfiltered", async () => {
    const a = await makeNote({ body: "qqneedle" });
    const b = await makeNote({ tags: [`${RUN}tag`, ""] });
    const all = await loadIndex(`?q=${RUN}`);
    expect(all.notes.map((n) => n.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await loadIndex("?q=qqneedle")).notes.map((n) => n.id)).toContain(a.id);
    expect((await loadIndex("?q=qqneedle")).notes.map((n) => n.id)).not.toContain(b.id);
    expect((await loadIndex(`?tag=${RUN}tag`)).notes.map((n) => n.id)).toEqual([b.id]);
    // garbage project slug → unfiltered, not a 422
    const degraded = await loadIndex("?project=kein-projekt");
    expect(degraded.notes.map((n) => n.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("?archived=1 shows archived notes instead of active ones", async () => {
    const n = await makeNote({ title: `${RUN} arch` });
    await postDetail(n.id, { _action: "archive" });
    expect((await loadIndex()).notes.map((x) => x.id)).not.toContain(n.id);
    expect((await loadIndex("?archived=1")).notes.map((x) => x.id)).toContain(n.id);
    await postDetail(n.id, { _action: "unarchive" });
  });
});

describe("/notes/new — create", () => {
  it("creates with the session user as author and redirects to the editor", async () => {
    const res = await postNew({ title: `${RUN} create`, body: "erste zeile" });
    if (!(res instanceof Response)) throw new Error("create did not redirect");
    const note = await db.note.findUniqueOrThrow({
      where: { id: res.headers.get("location")!.split("/").pop()! },
    });
    noteIds.push(note.id);
    expect(note.authorId).toBe(TEST_USER.id);
    expect(note.body).toBe("erste zeile");
    expect((await auditFor(note.id)).map((r) => r.action)).toEqual(["NoteCreated"]);
  });

  it("rejects an empty title as a form error, not a throw", async () => {
    const res = (await postNew({ title: "  " })) as { fieldErrors?: Record<string, string[]> };
    expect(res).not.toBeInstanceOf(Response);
    expect(res.fieldErrors?.title).toBeTruthy();
  });
});

describe("/notes/:id — actions", () => {
  it("autosave answers {ok} and audits the change; unchanged autosave writes no audit row", async () => {
    const n = await makeNote({ title: `${RUN} as`, body: "alt" });
    const changed = (await postDetail(n.id, {
      _action: "autosave",
      title: `${RUN} as`,
      body: "neu",
      version: String(n.version),
    })) as { ok?: boolean; version?: number };
    expect(changed).toEqual({ ok: true, version: n.version + 1 });
    expect((await db.note.findUniqueOrThrow({ where: { id: n.id } })).body).toBe("neu");

    const same = (await postDetail(n.id, {
      _action: "autosave",
      title: `${RUN} as`,
      body: "neu",
      version: String(n.version + 1),
    })) as { ok?: boolean; version?: number };
    expect(same).toEqual({ ok: true, version: n.version + 1 });
    const rows = await auditFor(n.id);
    expect(rows.map((r) => r.action)).toEqual(["NoteCreated", "NoteUpdated"]);
  });

  it("a stale autosave answers {conflict} with the stored note and writes nothing", async () => {
    const n = await makeNote({ title: `${RUN} cf`, body: "Ausgang" });
    await postDetail(n.id, {
      _action: "autosave",
      title: `${RUN} cf`,
      body: "von Tab A",
      version: String(n.version),
    });
    const stale = (await postDetail(n.id, {
      _action: "autosave",
      title: `${RUN} cf`,
      body: "von Tab B",
      version: String(n.version),
    })) as { conflict?: { message: string; current: { body: string; version: number } } };
    expect(stale.conflict?.message).toMatch(/gespeichert/);
    expect(stale.conflict?.current).toMatchObject({ body: "von Tab A", version: n.version + 1 });
    expect((await db.note.findUniqueOrThrow({ where: { id: n.id } })).body).toBe("von Tab A");
    expect((await auditFor(n.id)).map((r) => r.action)).toEqual(["NoteCreated", "NoteUpdated"]);
  });

  it("an autosave without a version is refused as invalid input", async () => {
    const n = await makeNote({ title: `${RUN} nv`, body: "bleibt" });
    const res = (await postDetail(n.id, {
      _action: "autosave",
      title: `${RUN} nv`,
      body: "ohne Version",
    })) as { ok?: boolean; error?: string };
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();
    expect((await db.note.findUniqueOrThrow({ where: { id: n.id } })).body).toBe("bleibt");
  });

  it("pin, archive, unarchive and delete ride the one action via _action", async () => {
    const n = await makeNote({ title: `${RUN} pa` });
    expect(await postDetail(n.id, { _action: "pin" })).toBeInstanceOf(Response);
    expect((await db.note.findUniqueOrThrow({ where: { id: n.id } })).pinned).toBe(true);
    expect(await postDetail(n.id, { _action: "archive" })).toBeInstanceOf(Response);
    expect((await db.note.findUniqueOrThrow({ where: { id: n.id } })).archivedAt).not.toBeNull();
    // archiving an already-archived note is a refusal → form error, no row
    const refuse = (await postDetail(n.id, { _action: "archive" })) as { formErrors?: string[] };
    expect(refuse.formErrors?.[0]).toMatch(/archiviert/);
    expect(await postDetail(n.id, { _action: "unarchive" })).toBeInstanceOf(Response);
    const del = await postDetail(n.id, { _action: "delete" });
    expect(del).toBeInstanceOf(Response);
    expect((del as Response).headers.get("location")).toBe("/notes");
    expect(await db.note.findUnique({ where: { id: n.id } })).toBeNull();
    noteIds.splice(noteIds.indexOf(n.id), 1);
    expect((await auditFor(n.id)).map((r) => r.action)).toEqual([
      "NoteCreated",
      "NotePinned",
      "NoteArchived",
      "NoteUnarchived",
      "NoteDeleted",
    ]);
  });
});

describe("/notes/:id/export", () => {
  it("serves text/markdown with an attachment filename and front-matter", async () => {
    const n = await makeNote({ title: `${RUN} export`, body: "inhalt", tags: ["x"] });
    const res = await exportRoute.loader({
      request: new Request(`http://localhost/notes/${n.id}/export`),
      params: { id: n.id },
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename=".*\.md"/);
    const text = await res.text();
    expect(text).toContain(`id: ${n.id}`);
    expect(text).toContain("inhalt");
    expect(text).toContain("- x");
  });
});

describe("/notes/import", () => {
  it("imports .md files and reports created/updated", async () => {
    const res = (await importRoute.action({
      request: post("http://localhost/notes/import", {
        files: [
          new File([`# ${RUN} imp1\n\ntext`], `${RUN}-a.md`, { type: "text/markdown" }),
          new File([`---\ntitle: ${RUN} imp2\npinned: true\n---\n\nbody`], `${RUN}-b.md`),
        ],
      }),
    } as never)) as { done?: { created: number; updated: number } };
    expect(res.done).toMatchObject({ created: 2, updated: 0 });
    const mine = await db.note.findMany({ where: { title: { startsWith: `${RUN} imp` } } });
    noteIds.push(...mine.map((n) => n.id));
    expect(mine.find((n) => n.title === `${RUN} imp2`)?.pinned).toBe(true);
  });

  it("rejects an oversize file before touching the domain", async () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], `${RUN}-big.md`);
    const res = (await importRoute.action({
      request: post("http://localhost/notes/import", { files: big }),
    } as never)) as { formErrors?: string[] };
    expect(res.formErrors?.[0]).toMatch(/zu groß/);
    expect(await db.note.count({ where: { title: { contains: "big" } } })).toBe(0);
  });

  it("a bad project slug aborts the batch and names the file", async () => {
    const res = (await importRoute.action({
      request: post("http://localhost/notes/import", {
        files: [
          new File([`# ${RUN} imp-ok`], `${RUN}-ok.md`),
          new File([`---\ntitle: x\nproject: gibt-es-nicht\n---\n\ny`], `${RUN}-bad.md`),
        ],
      }),
    } as never)) as { formErrors?: string[] };
    expect(res.formErrors?.[0]).toMatch(/nichts importiert/);
    expect(res.formErrors?.slice(1)).toEqual([expect.stringContaining(`${RUN}-bad.md`)]);
    expect(await db.note.count({ where: { title: `${RUN} imp-ok` } })).toBe(0);
  });

  it("an over-long note is rejected by name, beside every other rejected file", async () => {
    const res = (await importRoute.action({
      request: post("http://localhost/notes/import", {
        files: [
          new File([`# ${RUN} imp-fine\n\nkurz`], `${RUN}-fine.md`),
          new File([`# ${RUN} imp-long\n\n${"z".repeat(200_001)}`], `${RUN}-long.md`),
          new File([`---\ntitle: x\nproject: gibt-es-nicht\n---\n\ny`], `${RUN}-slug.md`),
        ],
      }),
    } as never)) as { formErrors?: string[] };
    expect(res.formErrors?.slice(1)).toEqual([
      expect.stringMatching(new RegExp(`${RUN}-long\\.md.*zu lang`)),
      expect.stringContaining(`${RUN}-slug.md`),
    ]);
    expect(await db.note.count({ where: { title: { startsWith: `${RUN} imp-` } } })).toBe(0);
  });
});
