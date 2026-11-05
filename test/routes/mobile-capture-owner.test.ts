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
const entryRoute = await import("~/routes/m._index/route");

const userIds: string[] = [];
const taskIds: string[] = [];
const noteIds: string[] = [];
const ticketIds: string[] = [];

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
  for (const id of ticketIds) await db.ticket.delete({ where: { id } }).catch(() => undefined);
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
  {
    name: "/m (ticket entry)",
    path: "/m",
    run: (request: Request) => entryRoute.action({ request } as never),
    find: (clientId: string) => db.ticket.findUnique({ where: { id: clientId } }),
    track: (id: string) => ticketIds.push(id),
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

describe("/m (ticket entry) capture", () => {
  it("answers a capture with { id } and creates the ticket under the client id", async () => {
    const clientId = newClientId();
    ticketIds.push(clientId);
    const res = (await entryRoute.action({
      request: captureRequest(
        "/m",
        { title: `${RUN} ticket`, type: "INCIDENT", status: "OPEN", clientId },
        ACTOR.id,
      ),
    } as never)) as Response;
    expect(await res.json()).toEqual({ id: clientId });
    const ticket = await db.ticket.findUnique({ where: { id: clientId } });
    expect(ticket).toMatchObject({ title: `${RUN} ticket`, reporterId: ACTOR.id });
  });

  it("a replay of the same capture keeps one ticket", async () => {
    const clientId = newClientId();
    ticketIds.push(clientId);
    for (let i = 0; i < 2; i++) {
      const res = (await entryRoute.action({
        request: captureRequest("/m", { title: `${RUN} replay`, clientId }, ACTOR.id),
      } as never)) as Response;
      expect(await res.json()).toEqual({ id: clientId });
    }
    expect(await db.ticket.count({ where: { id: clientId } })).toBe(1);
  });

  it("keeps the capture time of a replayed entry, and never a time in the future", async () => {
    const past = newClientId();
    const future = newClientId();
    ticketIds.push(past, future);
    const capturedAt = new Date(Date.now() - 10 * 60 * 60 * 1000);
    for (const [clientId, occurredAt] of [
      [past, capturedAt.toISOString()],
      [future, new Date(Date.now() + 60 * 60 * 1000).toISOString()],
    ] as const) {
      await entryRoute.action({
        request: captureRequest("/m", { title: `${RUN} when`, occurredAt, clientId }, ACTOR.id),
      } as never);
    }
    const replayed = await db.ticket.findUniqueOrThrow({ where: { id: past } });
    expect(replayed.occurredAt.toISOString()).toBe(capturedAt.toISOString());
    const skewed = await db.ticket.findUniqueOrThrow({ where: { id: future } });
    expect(skewed.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("answers an invalid capture with a 400 JSON error the queue can show", async () => {
    const clientId = newClientId();
    const res = (await entryRoute.action({
      request: captureRequest("/m", { title: "", clientId }, ACTOR.id),
    } as never)) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(await db.ticket.findUnique({ where: { id: clientId } })).toBeNull();
  });
});
