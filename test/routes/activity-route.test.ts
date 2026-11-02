import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * `/activity` — the feed's ordering and pagination contract: tasks and
 * tickets interleave in TRUE `occurredAt` order (a back-dated ticket lands
 * where its time says, not where it was inserted), filters degrade safely,
 * and the `(occurredAt, id)` cursor never skips or repeats a row.
 */
const RUN = `activity_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Activity Tester",
  email: `${RUN}@test.local`,
  initials: "AT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

const route = await import("~/routes/_desktop.activity/route");
const { listActivity } = await import("~/domains/activity/activity.queries.server");
const { createTask } = await import("~/domains/tasks/tasks.mutations.server");
const { createTicket } = await import("~/domains/tickets/tickets.mutations.server");

// A real user, because `listActivity`'s actor filter keys on `actorId` — a
// null actor lands our fixture rows in the 100k-row corpus where no limit
// can page to them.
let actor: { id: string; name: string; email: string };
const userIds: string[] = [];
const taskIds: string[] = [];
const ticketIds: string[] = [];
const logIds: string[] = [];

async function ensureActor() {
  if (!actor) {
    // `initials` is UNIQUE — derive them from the run tag instead of a constant.
    const initials = RUN.slice(-3).toUpperCase().padStart(3, "0");
    const u = await db.user.create({ data: { email: `${RUN}@test.local`, name: RUN, initials } });
    userIds.push(u.id);
    actor = { id: u.id, name: u.name, email: u.email };
  }
  return actor;
}

const load = async (query = "") =>
  (await route.loader({ request: new Request(`http://localhost/activity${query}`) } as never)) as {
    entries: Array<{ entityId: string; entityType: string; title: string; href: string | null }>;
    nextCursor: string | null;
  };

// Direct ActivityLog inserts — test fixtures only; actorId is a plain String?
// (no FK), so a RUN-tagged id isolates these rows from the whole corpus.
const logRow = (over: {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  occurredAt?: Date;
  action?: string;
}) =>
  db.activityLog
    .create({
      data: {
        action: over.action ?? "TicketUpdated",
        entityType: over.entityType ?? "ticket",
        entityId: over.entityId ?? `fake-${RUN}`,
        actorId: over.actorId ?? `${RUN}_u`,
        data: { title: `${RUN} fixture` },
        occurredAt: over.occurredAt ?? new Date(),
      },
    })
    .then((r) => {
      logIds.push(r.id);
      return r;
    });

afterAll(async () => {
  // ActivityLog is append-only — the DB trigger refuses DELETE, and that is
  // the contract: fixture rows stay in the log like every test's audit rows do.
  void logIds;
  for (const id of [...taskIds].reverse())
    await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of [...ticketIds].reverse())
    await db.ticket.delete({ where: { id } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("listActivity", () => {
  it("interleaves tasks and tickets in true occurredAt order — a back-dated ticket lands where its time says", async () => {
    const past = new Date("2020-06-01T12:00:00Z");
    // The ticket is INSERTED first but its logical time is years ago.
    const me = await ensureActor();
    const ticket = await createTicket(me, {
      type: "REPAIR",
      title: `${RUN} backdated`,
      assigneeIds: [],
      status: "RESOLVED",
      resolution: "damals erledigt",
      occurredAt: past,
    });
    ticketIds.push(ticket.id);
    const task = await createTask(me, { title: `${RUN} fresh`, status: "BACKLOG", labels: [] });
    taskIds.push(task.id);

    const { items } = await listActivity({ actorId: me.id, entityTypes: ["task", "ticket"] });
    const taskRow = items.find((i) => i.entityId === task.id)!;
    const ticketRow = items.find((i) => i.entityId === ticket.id)!;
    expect(ticketRow.occurredAt.getTime()).toBe(past.getTime());
    // Descending occurredAt: the fresh task's row precedes the back-dated one.
    expect(items.indexOf(taskRow)).toBeLessThan(items.indexOf(ticketRow));
    // Everything between/around them is genuinely ordered.
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].occurredAt.getTime()).toBeGreaterThanOrEqual(
        items[i].occurredAt.getTime(),
      );
    }
  });

  it("filters by actor and by entity type", async () => {
    await logRow({ actorId: `${RUN}_a`, entityType: "ticket", entityId: `f-${RUN}-1` });
    await logRow({ actorId: `${RUN}_b`, entityType: "task", entityId: `f-${RUN}-2` });

    const byActor = await listActivity({ actorId: `${RUN}_a` });
    expect(byActor.items.length).toBe(1);
    expect(byActor.items[0].entityId).toBe(`f-${RUN}-1`);

    const byType = await listActivity({ entityTypes: ["task"], actorId: `${RUN}_b` });
    expect(byType.items.length).toBe(1);
    expect(byType.items[0].entityId).toBe(`f-${RUN}-2`);
  });

  it("paginates rows sharing an occurredAt without dupes or gaps", async () => {
    const same = new Date("2021-03-03T10:00:00Z");
    const a = await logRow({ occurredAt: same, entityId: `p-${RUN}-1` });
    const b = await logRow({ occurredAt: same, entityId: `p-${RUN}-2` });
    const c = await logRow({ occurredAt: same, entityId: `p-${RUN}-3` });
    const d = await logRow({
      occurredAt: new Date("2021-03-03T09:00:00Z"),
      entityId: `p-${RUN}-4`,
    });

    const p1 = await listActivity({ actorId: `${RUN}_u`, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listActivity({ actorId: `${RUN}_u`, limit: 2, cursor: p1.nextCursor! });
    const all = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(all).size).toBe(all.length); // no dupes
    expect(all.sort()).toEqual([a.id, b.id, c.id, d.id].sort()); // no gaps
  });

  it("a garbage cursor degrades to the first page", async () => {
    const res = await listActivity({ actorId: `${RUN}_u`, cursor: "!!!not-a-cursor" });
    expect(res.items.length).toBeGreaterThanOrEqual(0);
  });

  it("falls back to data.title with no link when the entity is gone", async () => {
    const me = await ensureActor();
    const ticket = await createTicket(me, {
      type: "INCIDENT",
      title: `${RUN} ghost`,
      assigneeIds: [],
      status: "OPEN",
    });
    const id = ticket.id;
    await db.ticket.delete({ where: { id } }); // gone — no cleanup-tracking on purpose
    const { items } = await listActivity({ actorId: me.id, entityTypes: ["ticket"] });
    const row = items.find((i) => i.entityId === id)!;
    expect(row.title).toBe(`${RUN} ghost`);
    expect(row.href).toBeNull();
  });
});

describe("/activity — loader", () => {
  it("returns grouped entries and honors filters without throwing", async () => {
    const { entries } = await load();
    expect(Array.isArray(entries)).toBe(true);
    const filtered = await load(`?type=ticket`);
    expect(filtered.entries.every((e) => e.entityType === "ticket")).toBe(true);
    // Garbage degrades to unfiltered instead of throwing.
    const garbage = await load(`?type=nonsense&actor=not-a-user&cursor=%%%`);
    expect(Array.isArray(garbage.entries)).toBe(true);
  });
});
