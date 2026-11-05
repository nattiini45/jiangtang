import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { CAPTURE_HEADER, CAPTURE_OWNER_HEADER, newClientId } from "~/lib/pwa/offline-queue";

/**
 * The mobile capture actions against the owner a queued capture was bound to:
 * the browser shares one cookie jar across tabs, so a stale tab can replay one
 * person's captures while another person is signed in. The action must refuse
 * that before it writes anything. Actions are called directly against the real
 * database, as in the other route tests.
 */
const RUN = `capown_${Date.now().toString(36)}`;

const ACTOR = {
  id: null as unknown as string,
  name: "Capture Tester",
  email: `${RUN}@test.local`,
  initials: "CT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => ACTOR) };
});

const taskRoute = await import("~/routes/m.tasks.new/route");
const noteRoute = await import("~/routes/m.notes.new/route");

const userIds: string[] = [];
const taskIds: string[] = [];
const noteIds: string[] = [];

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: ACTOR.email!, name: ACTOR.name!, initials: "CT" },
  });
  userIds.push(user.id);
  ACTOR.id = user.id;
});

afterAll(async () => {
  for (const id of taskIds) await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of noteIds) await db.note.delete({ where: { id } }).catch(() => undefined);
  for (const id of userIds) await db.user.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

function captureRequest(path: string, fields: Record<string, string>, owner?: string): Request {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    [CAPTURE_HEADER]: "1",
  });
  if (owner !== undefined) headers.set(CAPTURE_OWNER_HEADER, owner);
  return new Request(`http://localhost${path}.data`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

async function thrownResponse(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error("expected the action to throw a Response");
}

const surfaces = [
  {
    name: "/m/tasks/new",
    path: "/m/tasks/new",
    run: (request: Request) => taskRoute.action({ request } as never),
    find: (clientId: string) => db.task.findUnique({ where: { id: clientId } }),
    track: (id: string) => taskIds.push(id),
  },
  {
    name: "/m/notes/new",
    path: "/m/notes/new",
    run: (request: Request) => noteRoute.action({ request } as never),
    find: (clientId: string) => db.note.findUnique({ where: { id: clientId } }),
    track: (id: string) => noteIds.push(id),
  },
];

describe.each(surfaces)("$name capture owner", (surface) => {
  it("creates the row when the queued owner is the signed-in user", async () => {
    const clientId = newClientId();
    surface.track(clientId);
    const res = (await surface.run(
      captureRequest(surface.path, { title: `${RUN} match`, clientId }, ACTOR.id),
    )) as Response;
    expect(await res.json()).toEqual({ id: clientId });
    expect(await surface.find(clientId)).not.toBeNull();
  });

  it("refuses with 403 and writes nothing when the queued owner is someone else", async () => {
    const clientId = newClientId();
    surface.track(clientId);
    const refusal = await thrownResponse(() =>
      surface.run(
        captureRequest(
          surface.path,
          { title: `${RUN} foreign`, clientId },
          "cforeignuser0000000000001",
        ),
      ),
    );
    expect(refusal.status).toBe(403);
    expect(await surface.find(clientId)).toBeNull();
    const audited = await db.activityLog.count({ where: { entityId: clientId } });
    expect(audited).toBe(0);
  });

  it("treats an empty owner header as a mismatch, not as absent", async () => {
    const clientId = newClientId();
    surface.track(clientId);
    const refusal = await thrownResponse(() =>
      surface.run(captureRequest(surface.path, { title: `${RUN} blank`, clientId }, "")),
    );
    expect(refusal.status).toBe(403);
    expect(await surface.find(clientId)).toBeNull();
  });

  it("behaves as before when the request names no owner", async () => {
    const clientId = newClientId();
    surface.track(clientId);
    const res = (await surface.run(
      captureRequest(surface.path, { title: `${RUN} anonymous`, clientId }),
    )) as Response;
    expect(await res.json()).toEqual({ id: clientId });
    expect(await surface.find(clientId)).not.toBeNull();
  });
});
