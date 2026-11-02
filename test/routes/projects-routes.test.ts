import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for the `/projects*` routes — the
 * `locations-routes.test.ts` shape, one surface over.
 *
 * ⚠️ **This is not a render test.** Vitest runs in `node` with no DOM, so these
 * call the exported `loader`/`action` directly against the real dev database.
 * What is provable here is that the routes compute the right answer, refuse the
 * right things, and write nothing when they refuse.
 *
 * `requireUser` is mocked to a fixed actor; every other export of
 * `~/lib/auth.server` is preserved.
 */
const RUN = `projects_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Projects Tester",
  email: `${RUN}@test.local`,
  initials: "PT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Imported AFTER the mock so the route modules see the mocked requireUser.
const indexRoute = await import("~/routes/_desktop.projects._index/route");
const newRoute = await import("~/routes/_desktop.projects.new/route");
const detailRoute = await import("~/routes/_desktop.projects.$slug/route");
const editRoute = await import("~/routes/_desktop.projects.$slug_.edit/route");

const createdIds: string[] = [];

/** Creates a project through the REAL route action — the full post path. */
async function postCreate(body: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return newRoute.action({
    request: new Request("http://localhost/projects/new", { method: "POST", body: form }),
  } as never);
}

async function makeProject(name: string, over: Record<string, string> = {}) {
  const res = await postCreate({ name: `${RUN} ${name}`, ...over });
  if (!(res instanceof Response))
    throw new Error(`create did not redirect: ${JSON.stringify(res)}`);
  const slug = res.headers.get("location")!.split("/").pop()!;
  const project = (await db.project.findUnique({ where: { slug } }))!;
  createdIds.push(project.id);
  return project;
}

const loadIndex = async (query = "") =>
  (await indexRoute.loader({
    request: new Request(`http://localhost/projects${query}`),
  } as never)) as {
    projects: Array<{ id: string; name: string; status: string; slug: string }>;
    filters: { status: string; leadId: string; q: string };
  };

const mine = <T extends { name: string }>(r: { projects: T[] }): T[] =>
  r.projects.filter((p) => p.name.startsWith(RUN));

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await db.project.delete({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

describe("/projects — index", () => {
  it("lists projects with task counts and honours ?status= / ?q= filters", async () => {
    await makeProject("Angefragt", { status: "REQUESTED" });
    await makeProject("Bestätigt", { status: "CONFIRMED" });

    const all = mine(await loadIndex("?q=" + encodeURIComponent(RUN)));
    expect(all).toHaveLength(2);

    const filtered = mine(await loadIndex(`?q=${encodeURIComponent(RUN)}&status=CONFIRMED`));
    expect(filtered.map((p) => p.status)).toEqual(["CONFIRMED"]);

    // A garbage status parses (every field is optional) and degrades to the
    // unfiltered view rather than throwing — the URL-param contract.
    const degraded = mine(await loadIndex(`?q=${encodeURIComponent(RUN)}&status=NOPE`));
    expect(degraded).toHaveLength(2);
  });
});

describe("/projects/new — create", () => {
  it("redirects to /projects/:slug and audits one ProjectCreated row", async () => {
    const p = await makeProject("Erstellt", { description: "aus der Route" });
    expect(p.description).toBe("aus der Route");
    const logs = await db.activityLog.findMany({
      where: { entityType: "project", entityId: p.id },
    });
    expect(logs.map((l) => l.action)).toEqual(["ProjectCreated"]);
  });

  it("an invalid body returns field errors instead of writing", async () => {
    const res = await postCreate({ name: "" });
    expect(res).not.toBeInstanceOf(Response);
    expect((res as { fieldErrors: Record<string, string[]> }).fieldErrors.name).toBeDefined();
  });
});

describe("/projects/:slug — detail + status change", () => {
  it("loads by slug and a status post writes ProjectStatusChanged", async () => {
    const p = await makeProject("Statusbar", { status: "REQUESTED" });

    const data = (await detailRoute.loader({
      params: { slug: p.slug },
      request: new Request(`http://localhost/projects/${p.slug}`),
    } as never)) as { project: { id: string; tasks: unknown[]; subProjects: unknown[] } };
    expect(data.project.id).toBe(p.id);

    const form = new FormData();
    form.set("_action", "status");
    form.set("status", "CONFIRMED");
    const res = await detailRoute.action({
      request: new Request(`http://localhost/projects/${p.slug}`, { method: "POST", body: form }),
      params: { slug: p.slug },
    } as never);
    expect((res as { status: string }).status).toBe("CONFIRMED");
    expect((await db.project.findUnique({ where: { id: p.id } }))?.status).toBe("CONFIRMED");

    const logs = await db.activityLog.findMany({
      where: { entityType: "project", entityId: p.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(logs.map((l) => l.action)).toEqual(["ProjectCreated", "ProjectStatusChanged"]);
  });

  it("an unknown slug 404s instead of rendering an empty page", async () => {
    await expect(
      detailRoute.loader({
        params: { slug: `${RUN}-nope` },
        request: new Request("http://localhost/projects/nope"),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("/projects/:slug/edit — update + delete", () => {
  it("update keeps the slug stable; delete refuses while a sub-project exists", async () => {
    const parent = await makeProject("Eltern", { status: "REQUESTED" });
    const child = await makeProject("Kind", { parentProjectId: parent.id });

    const form = new FormData();
    form.set("_action", "update");
    form.set("name", `${RUN} Eltern umbenannt`);
    const res = await editRoute.action({
      request: new Request(`http://localhost/projects/${parent.slug}/edit`, {
        method: "POST",
        body: form,
      }),
      params: { slug: parent.slug },
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).headers.get("location")).toBe(`/projects/${parent.slug}`);
    expect((await db.project.findUnique({ where: { id: parent.id } }))?.name).toBe(
      `${RUN} Eltern umbenannt`,
    );

    const del = new FormData();
    del.set("_action", "delete");
    const refused = await editRoute.action({
      request: new Request(`http://localhost/projects/${parent.slug}/edit`, {
        method: "POST",
        body: del,
      }),
      params: { slug: parent.slug },
    } as never);
    expect(refused).not.toBeInstanceOf(Response);
    expect((refused as { formErrors: string[] }).formErrors[0]).toMatch(/Teilprojekt/);
    expect(await db.project.findUnique({ where: { id: parent.id } })).not.toBeNull();

    // Detach the child, then the delete goes through.
    const reparent = new FormData();
    reparent.set("_action", "update");
    reparent.set("name", child.name);
    reparent.set("parentProjectId", "");
    await editRoute.action({
      request: new Request(`http://localhost/projects/${child.slug}/edit`, {
        method: "POST",
        body: reparent,
      }),
      params: { slug: child.slug },
    } as never);

    const gone = await editRoute.action({
      request: new Request(`http://localhost/projects/${parent.slug}/edit`, {
        method: "POST",
        body: del,
      }),
      params: { slug: parent.slug },
    } as never);
    expect(gone).toBeInstanceOf(Response);
    expect((gone as Response).headers.get("location")).toBe("/projects");
    expect(await db.project.findUnique({ where: { id: parent.id } })).toBeNull();
  });
});
