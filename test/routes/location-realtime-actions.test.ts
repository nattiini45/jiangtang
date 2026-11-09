import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { requireUser, type AuthUser } from "~/lib/auth.server";
import type { ActivityLog, Location } from "~/generated/prisma/client";
import { emitChange } from "~/lib/realtime/emit.server";

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn() };
});

vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

const newRoute = await import("~/routes/_desktop.locations.new/route");
const editRoute = await import("~/routes/_desktop.locations.$id_.edit/route");

const RUN = `location_realtime_${Date.now()}`;
const actor: AuthUser = {
  id: `${RUN}_actor`,
  name: "Location Realtime Tester",
  email: `${RUN}@test.local`,
  initials: null,
  role: "MEMBER",
  isActive: true,
  emailVerified: false,
  twoFactorEnabled: false,
  weeklyCapacityMinutes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const created: string[] = [];
const observed: Array<{
  event: Parameters<typeof emitChange>[0];
  location: Location | null;
  audit: ActivityLog[];
}> = [];
let sequence = 0;
let ids: { root: string; child: string; leaf: string };

beforeAll(async () => {
  await db.user.create({ data: actor });
});

beforeEach(async () => {
  vi.mocked(requireUser).mockReset().mockResolvedValue(actor);
  observed.length = 0;
  vi.mocked(emitChange)
    .mockReset()
    .mockImplementation(async (event) => {
      const [location, audit] = await Promise.all([
        db.location.findUnique({ where: { id: event.id } }),
        db.activityLog.findMany({ where: { entityId: event.id } }),
      ]);
      observed.push({ event, location, audit });
    });
  sequence += 1;
  ids = {
    root: `${RUN}_${sequence}_root`,
    child: `${RUN}_${sequence}_child`,
    leaf: `${RUN}_${sequence}_leaf`,
  };
  await db.location.createMany({
    data: Object.values(ids).map((id) => ({ id, name: id, kind: "STORAGE" as const })),
  });
  created.push(...Object.values(ids));
  await db.location.update({ where: { id: ids.child }, data: { parentId: ids.root } });
});

afterAll(async () => {
  await db.location.updateMany({ where: { id: { in: created } }, data: { parentId: null } });
  await db.location.deleteMany({ where: { id: { in: created } } });
  await db.user.delete({ where: { id: actor.id } });
  await db.$disconnect();
});

function request(path: string, body: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: "locale=en" },
    body: new URLSearchParams(body),
  });
}

function create(body: Record<string, string>) {
  return newRoute.action({ request: request("/locations/new", body) } as never);
}

function edit(body: Record<string, string>, id = ids.leaf) {
  return editRoute.action({
    request: request(`/locations/${id}/edit`, body),
    params: { id },
  } as never);
}

function expectRedirect(result: unknown, path: string) {
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(302);
  expect((result as Response).headers.get("location")).toBe(path);
}

async function snapshot() {
  return {
    locations: await db.location.findMany({
      where: { id: { in: created } },
      orderBy: { id: "asc" },
    }),
    createdCount: await db.location.count({ where: { createdById: actor.id } }),
    auditCount: await db.activityLog.count({ where: { actorId: actor.id } }),
  };
}

async function expectAudit(
  id: string,
  action: string,
  before: number,
  op: Parameters<typeof emitChange>[0]["op"],
) {
  expect(await db.activityLog.count({ where: { actorId: actor.id } })).toBe(before + 1);
  const audit = await db.activityLog.findMany({ where: { entityId: id } });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action,
    entityType: "location",
    actorId: actor.id,
    actorSnapshot: { name: actor.name, email: actor.email },
  });
  const event = { entityType: "location", id, op };
  expect(emitChange).toHaveBeenCalledExactlyOnceWith(event);
  expect(observed).toEqual([
    { event, location: await db.location.findUnique({ where: { id } }), audit },
  ]);
  return audit[0];
}

describe("desktop location action commits", () => {
  it("creates a child, records its actor and audit, and redirects to its detail", async () => {
    const before = await snapshot();
    const result = await create({
      name: `${RUN} new`,
      kind: "RACK",
      code: "TEST-RACK",
      address: "Synthetic aisle",
      description: "Synthetic rack",
      parentId: ids.root,
    });
    const location = await db.location.findFirstOrThrow({ where: { createdById: actor.id } });
    created.push(location.id);
    expectRedirect(result, `/locations/${location.id}`);
    expect(location).toMatchObject({
      name: `${RUN} new`,
      kind: "RACK",
      code: "TEST-RACK",
      address: "Synthetic aisle",
      description: "Synthetic rack",
      parentId: ids.root,
      createdById: actor.id,
    });
    await expectAudit(location.id, "LocationCreated", before.auditCount, "created");
  });

  it("updates editable fields without reparenting and redirects to the same detail", async () => {
    const before = await snapshot();
    const result = await edit({
      name: `${RUN} renamed`,
      kind: "ROOM",
      code: "",
      address: "",
      description: "",
      parentId: ids.root,
    });
    expectRedirect(result, `/locations/${ids.leaf}`);
    expect(await db.location.findUnique({ where: { id: ids.leaf } })).toMatchObject({
      name: `${RUN} renamed`,
      kind: "ROOM",
      code: null,
      address: null,
      description: null,
      parentId: null,
    });
    await expectAudit(ids.leaf, "LocationUpdated", before.auditCount, "updated");
  });

  it("moves a subtree to a new parent and redirects to the moved node", async () => {
    const before = await snapshot();
    const result = await edit({ _action: "move", parentId: ids.leaf }, ids.root);
    expectRedirect(result, `/locations/${ids.root}`);
    expect(await db.location.findUnique({ where: { id: ids.root } })).toMatchObject({
      parentId: ids.leaf,
    });
    expect(await db.location.findUnique({ where: { id: ids.child } })).toMatchObject({
      parentId: ids.root,
    });
    const audit = await expectAudit(ids.root, "LocationMoved", before.auditCount, "updated");
    expect(audit.data).toMatchObject({ fromParentId: null, toParentId: ids.leaf });
  });

  it("deletes a childless location, retains its audit, and redirects to the index", async () => {
    const before = await snapshot();
    const result = await edit({ _action: "delete" });
    expectRedirect(result, "/locations");
    expect(await db.location.findUnique({ where: { id: ids.leaf } })).toBeNull();
    await expectAudit(ids.leaf, "LocationDeleted", before.auditCount, "deleted");
  });
});

describe("desktop location action refusals", () => {
  it.each([
    ["create validation", "name"],
    ["create missing parent", "parentId"],
    ["update validation", "name"],
    ["move validation", "parentId"],
    ["move self", "parentId"],
    ["move subtree", "parentId"],
    ["move unchanged", "parentId"],
    ["move missing parent", "parentId"],
    ["delete parent", null],
  ])("returns inline errors without a row or audit change for %s", async (scenario, field) => {
    const before = await snapshot();
    let result: unknown;
    switch (scenario) {
      case "create validation":
        result = await create({ name: "", kind: "ROOM" });
        break;
      case "create missing parent":
        result = await create({ name: `${RUN} refused`, kind: "ROOM", parentId: `${RUN}_missing` });
        break;
      case "update validation":
        result = await edit({ name: "", kind: "ROOM" });
        break;
      case "move validation":
        result = await edit({ _action: "move" });
        break;
      case "move self":
        result = await edit({ _action: "move", parentId: ids.leaf });
        break;
      case "move subtree":
        result = await edit({ _action: "move", parentId: ids.child }, ids.root);
        break;
      case "move unchanged":
        result = await edit({ _action: "move", parentId: "" });
        break;
      case "move missing parent":
        result = await edit({ _action: "move", parentId: `${RUN}_missing` });
        break;
      case "delete parent":
        result = await edit({ _action: "delete" }, ids.root);
        break;
    }
    expect(result).not.toBeInstanceOf(Response);
    const errors = result as { fieldErrors: Record<string, string[]>; formErrors: string[] };
    if (field) expect(errors.fieldErrors[field]?.[0]).toBeTruthy();
    else expect(errors.formErrors[0]).toMatch(/1/);
    expect(await snapshot()).toEqual(before);
    expect(emitChange).not.toHaveBeenCalled();
  });

  it.each(["update", "move", "delete"])("returns 404 for %s of a missing node", async (intent) => {
    const before = await snapshot();
    await expect(
      edit({ _action: intent, name: "Missing", kind: "ROOM", parentId: "" }, `${RUN}_missing`),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    expect(emitChange).not.toHaveBeenCalled();
  });

  it.each([
    ["create", 302],
    ["update", 302],
    ["move", 302],
    ["delete", 302],
    ["create", 403],
    ["update", 403],
    ["move", 403],
    ["delete", 403],
  ])("preserves the auth refusal for %s (%i) before any write", async (intent, status) => {
    const before = await snapshot();
    const refusal = new Response(null, { status, headers: { location: "/login" } });
    vi.mocked(requireUser).mockRejectedValueOnce(refusal);
    const body = { _action: String(intent), name: "Denied", kind: "ROOM", parentId: ids.root };
    await expect(intent === "create" ? create(body) : edit(body)).rejects.toBe(refusal);
    expect(requireUser).toHaveBeenCalledExactlyOnceWith(expect.any(Request));
    expect(await snapshot()).toEqual(before);
    expect(emitChange).not.toHaveBeenCalled();
  });
});
