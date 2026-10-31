import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for `/board` — the fetcher contract of the
 * `move` intent: `{ok}` on success, `{error}` on refusal, never a redirect
 * (the board already moved the card visually).
 */
const RUN = `b48_board_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Board Tester",
  email: `${RUN}@test.local`,
  initials: "BT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

const boardRoute = await import("~/routes/_desktop.board/route");
const { createTask } = await import("~/domains/tasks/tasks.mutations.server");
const { listBoardTasks } = await import("~/domains/tasks/tasks.queries.server");
const { createTicket } = await import("~/domains/tickets/tickets.mutations.server");

const actor = { id: null, name: "board test", email: `${RUN}@t` };
const taskIds: string[] = [];
const ticketIds: string[] = [];

async function make(title: string, over: Record<string, unknown> = {}) {
  const t = await createTask(actor, {
    title: `${RUN} ${title}`,
    status: "BACKLOG",
    labels: [],
    ...over,
  });
  taskIds.push(t.id);
  return t;
}

async function makeTicket(title: string, over: Record<string, unknown> = {}) {
  const t = await createTicket(actor, {
    type: "INCIDENT",
    title: `${RUN} ${title}`,
    assigneeIds: [],
    status: "OPEN",
    ...over,
  });
  ticketIds.push(t.id);
  return t;
}

const postMove = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return boardRoute.action({
    request: new Request("http://localhost/board", { method: "POST", body: form }),
  } as never);
};

const loadBoard = async (query = "") =>
  (await boardRoute.loader({
    request: new Request(`http://localhost/board${query}`),
  } as never)) as {
    lanes: Record<string, Array<{ id: string; title: string; status: string }>>;
    ticketLanes: Record<string, Array<{ id: string; title: string; status: string }>>;
  };

const mine = (lanes: Record<string, Array<{ id: string; title: string }>>, lane: string) =>
  lanes[lane].filter((t) => t.title.startsWith(RUN));

afterAll(async () => {
  for (const id of [...taskIds].reverse())
    await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of [...ticketIds].reverse())
    await db.ticket.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe("/board — loader", () => {
  it("groups board tasks into the five lanes", async () => {
    await make("one");
    const { lanes } = await loadBoard();
    expect(Object.keys(lanes).sort()).toEqual(
      ["BACKLOG", "CANCELLED", "DONE", "IN_PROGRESS", "IN_REVIEW"].sort(),
    );
    expect(mine(lanes, "BACKLOG").map((t) => t.title)).toEqual([`${RUN} one`]);
  });
});

describe("/board — move action", () => {
  it("moves a card across lanes and maps the status to the lane default", async () => {
    const t = await make("x-lane");
    const res = (await postMove({ _action: "move", taskId: t.id, lane: "DONE" })) as {
      ok?: boolean;
    };
    expect(res.ok).toBe(true);
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DONE");
    const { lanes } = await loadBoard();
    expect(mine(lanes, "DONE").map((x) => x.id)).toEqual([t.id]);
  });

  it("keeps a status that belongs to the target lane and orders between neighbours", async () => {
    const a = await make("n1", { status: "DONE" });
    const b = await make("n2", { status: "DONE" });
    const c = await make("n3", { status: "DONE" });
    const res = (await postMove({
      _action: "move",
      taskId: c.id,
      lane: "DONE",
      afterId: a.id,
      beforeId: b.id,
    })) as {
      ok?: boolean;
    };
    expect(res.ok).toBe(true);
    const board = await listBoardTasks();
    const ids = [a.id, b.id, c.id];
    const done = board.filter((t) => ids.includes(t.id));
    expect(done.map((t) => t.id)).toEqual([a.id, c.id, b.id]);
    expect((await db.task.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("DONE");
  });

  it("answers {error} for stale neighbours sent in the wrong order — nothing written", async () => {
    const a = await make("s1");
    const b = await make("s2");
    const c = await make("s3");
    const posBefore = (
      await db.task.findUniqueOrThrow({ where: { id: c.id } })
    ).position.toString();
    const res = (await postMove({
      _action: "move",
      taskId: c.id,
      lane: "BACKLOG",
      afterId: b.id,
      beforeId: a.id,
    })) as {
      error?: string;
    };
    expect(res.error).toMatch(/Spalte hat sich geändert/);
    expect((await db.task.findUniqueOrThrow({ where: { id: c.id } })).position.toString()).toBe(
      posBefore,
    );
  });

  it("answers {error} for a neighbour outside the lane", async () => {
    const other = await make("other", { status: "IN_PROGRESS" });
    const t = await make("bl");
    const res = (await postMove({
      _action: "move",
      taskId: t.id,
      lane: "BACKLOG",
      afterId: other.id,
    })) as {
      error?: string;
    };
    expect(res.error).toBeTruthy();
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("BACKLOG");
  });
});

describe("/board — work mode", () => {
  it("default mode returns tasks only; ?mode=work returns both families", async () => {
    await make("wm-task");
    const ticket = await makeTicket("wm-ticket");
    const plain = await loadBoard();
    expect(plain.ticketLanes.BACKLOG.filter((t) => t.id === ticket.id)).toEqual([]);
    const work = await loadBoard("?mode=work");
    expect(mine(work.lanes, "BACKLOG").map((t) => t.title)).toContain(`${RUN} wm-task`);
    expect(work.ticketLanes.BACKLOG.map((t) => t.id)).toContain(ticket.id);
  });

  it("move-ticket maps the lane through TICKET_LANE_STATUS", async () => {
    const t = await makeTicket("move-me");
    // OPEN sits in BACKLOG; every leg stays inside ALLOWED_TRANSITIONS
    // (RESOLVED→CANCELLED is illegal, so DONE is exercised from OPEN).
    for (const [lane, status] of [
      ["IN_PROGRESS", "IN_PROGRESS"],
      ["CANCELLED", "CANCELLED"],
      ["BACKLOG", "OPEN"],
      ["DONE", "RESOLVED"],
    ] as const) {
      const res = (await postMove({ _action: "move-ticket", ticketId: t.id, lane })) as {
        ok?: boolean;
      };
      expect(res.ok).toBe(true);
      expect((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(status);
    }
  });

  it("refuses a ticket drop on IN_REVIEW — no review column", async () => {
    const t = await makeTicket("no-review");
    const res = (await postMove({ _action: "move-ticket", ticketId: t.id, lane: "IN_REVIEW" })) as {
      error?: string;
    };
    expect(res.error).toMatch(/Review-Spalte/);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });

  it("refuses an illegal transition with the transition message", async () => {
    const t = await makeTicket("illegal", { status: "RESOLVED", resolution: "erledigt" });
    const res = (await postMove({ _action: "move-ticket", ticketId: t.id, lane: "CANCELLED" })) as {
      error?: string;
    };
    expect(res.error).toMatch(/Ungültiger Statuswechsel/);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("RESOLVED");
  });

  it("a same-lane move answers ok but writes nothing and audits nothing", async () => {
    const t = await makeTicket("same-lane");
    const before = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
    const audits = await db.activityLog.count({ where: { entityType: "ticket", entityId: t.id } });
    const res = (await postMove({ _action: "move-ticket", ticketId: t.id, lane: "BACKLOG" })) as {
      ok?: boolean;
    };
    expect(res.ok).toBe(true);
    const after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.activityLog.count({ where: { entityType: "ticket", entityId: t.id } })).toBe(
      audits,
    );
  });
});
