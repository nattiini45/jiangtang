import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import {
  createTask,
  deleteTask,
  moveTask,
  setTaskAssignees,
  setTaskStatus,
  updateTask,
} from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker, removeTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { listBoardTasks, listTasks } from "~/domains/tasks/tasks.queries.server";
import { taskCreateSchema } from "~/domains/tasks/tasks.schema";
import type { TaskCreateInput, TaskEditInput } from "~/domains/tasks/tasks.schema";
import { LANES, TASK_LANE_DEFAULT_STATUS } from "~/domains/tasks/tasks.lanes";

/**
 * Tasks-domain mutation guards, one per acceptance criterion — the
 * `locations.mutations.test.ts`/`projects.test.ts` shape, one folder over:
 *
 *   - every mutation runs through `txWithAudit` and writes its ActivityLog row
 *     in the same transaction                          → the audit assertions
 *   - a REFUSED mutation (self-edge, duplicate, cycle, out-of-lane neighbour,
 *     same status, delete-with-subtasks, unknown FK) writes nothing at all
 *   - `moveTask` owns fractional position: midpoint, exhaustion → rebalance,
 *     no-op writes nothing
 *
 * ActivityLog is append-only; assertions are scoped to ids this file created.
 */

const RUN = `task_${Date.now().toString(36)}`;
const actor = { id: null, name: "Task Tester", initials: "TT" };

const createdIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await db.task.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

function input(over: Partial<TaskCreateInput> & { title: string }): TaskCreateInput {
  return {
    body: undefined,
    status: "BACKLOG",
    priority: undefined,
    startAt: undefined,
    dueAt: undefined,
    estimateMinutes: undefined,
    projectId: undefined,
    parentTaskId: undefined,
    locationId: undefined,
    labels: [],
    ...over,
  };
}

async function make(over: Partial<TaskCreateInput> & { title: string }) {
  const task = await createTask(actor, input(over));
  createdIds.push(task.id);
  return task;
}

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: {
      email: `${RUN}-${tag}@test.local`,
      name: `${RUN} ${tag}`,
      initials: `${RUN.slice(-3)}${tag}`,
    },
  });
  userIds.push(user.id);
  return user;
}

function auditFor(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "task", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

/** Current position of a persisted row — the read-half of every move test. */
const pos = async (id: string) =>
  (await db.task.findUniqueOrThrow({ where: { id }, select: { position: true } })).position;

describe("createTask", () => {
  it("lands at the END of its status's lane and audits TaskCreated", async () => {
    const a = await make({ title: `${RUN}-a`, status: "TODO" });
    const b = await make({ title: `${RUN}-b`, status: "TODO" });
    expect(b.position.sub(a.position).toString()).toBe("1");

    const logs = await auditFor(a.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("TaskCreated");
  });

  it("refuses unknown project/parent/location references — and writes no audit row", async () => {
    const before = await db.activityLog.count({ where: { entityType: "task" } });
    await expect(make({ title: `${RUN}-badp`, projectId: "nope" })).rejects.toThrow(
      ValidationError,
    );
    await expect(make({ title: `${RUN}-badt`, parentTaskId: "nope" })).rejects.toThrow(
      ValidationError,
    );
    await expect(make({ title: `${RUN}-badl`, locationId: "nope" })).rejects.toThrow(
      ValidationError,
    );
    expect(await db.activityLog.count({ where: { entityType: "task" } })).toBe(before);
  });

  it("clientId makes createTask idempotent — same row, ONE audit entry", async () => {
    const clientId = `c${RUN.replace(/[^a-z0-9]/g, "")}task1`.padEnd(25, "0").slice(0, 25);
    const first = await createTask(actor, input({ title: `${RUN}-idem` }), [], clientId);
    createdIds.push(first.id);
    expect(first.id).toBe(clientId);
    const second = await createTask(actor, input({ title: `${RUN}-idem-doppelt` }), [], clientId);
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title); // the replay keeps the FIRST row
    expect(await auditFor(clientId)).toHaveLength(1);
  });

  it("concurrent clientId creates resolve to one row and one audit entry", async () => {
    const clientId = `c${RUN.replace(/[^a-z0-9]/g, "")}race`.padEnd(25, "0").slice(0, 25);
    const [a, b] = await Promise.all([
      createTask(actor, input({ title: `${RUN}-race-a` }), [], clientId),
      createTask(actor, input({ title: `${RUN}-race-b` }), [], clientId),
    ]);
    createdIds.push(a.id);
    expect(a.id).toBe(clientId);
    expect(b.id).toBe(clientId);
    expect(await db.task.count({ where: { id: clientId } })).toBe(1);
    expect(await auditFor(clientId)).toHaveLength(1);
  });

  it("a malformed clientId is refused, not silently stored", async () => {
    await expect(
      createTask(actor, input({ title: `${RUN}-badid` }), [], "not-a-cuid"),
    ).rejects.toThrow(ValidationError);
  });
});

describe("updateTask — parent reparenting", () => {
  const edit = (id: string, over: Partial<TaskEditInput>): TaskEditInput => ({
    id,
    title: `${RUN}-edited`,
    body: undefined,
    priority: undefined,
    startAt: undefined,
    dueAt: undefined,
    estimateMinutes: undefined,
    projectId: undefined,
    parentTaskId: undefined,
    locationId: undefined,
    labels: [],
    ...over,
  });

  it("refuses parent = self and parent = a descendant, with no audit row", async () => {
    const root = await make({ title: `${RUN}-root` });
    const child = await make({ title: `${RUN}-child`, parentTaskId: root.id });
    const grand = await make({ title: `${RUN}-grand`, parentTaskId: child.id });

    const before = (await auditFor(root.id)).length;
    await expect(
      updateTask(actor, root.id, edit(root.id, { parentTaskId: root.id })),
    ).rejects.toThrow(ValidationError);
    await expect(
      updateTask(actor, root.id, edit(root.id, { parentTaskId: grand.id })),
    ).rejects.toThrow(ValidationError);
    expect((await auditFor(root.id)).length).toBe(before);
    expect((await db.task.findUnique({ where: { id: root.id } }))?.parentTaskId).toBeNull();
  });
});

describe("setTaskStatus", () => {
  it("audits TaskStatusChanged {from,to} and moves the card to the end of the new lane", async () => {
    const t = await make({ title: `${RUN}-sc`, status: "TODO" });
    const tail = await db.task.findFirst({
      where: { status: { in: ["DONE"] } },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    await setTaskStatus(actor, t.id, "DONE");
    const after = await db.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe("DONE");
    expect(after.position.toString()).toBe(tail ? tail.position.add(1).toString() : "1");

    const logs = await auditFor(t.id);
    expect(logs.map((l) => l.action)).toEqual(["TaskCreated", "TaskStatusChanged"]);
    expect(logs[1].data).toMatchObject({ from: "TODO", to: "DONE" });
  });

  it("refuses the status the task already has — no change, no audit row", async () => {
    const t = await make({ title: `${RUN}-sc-same`, status: "TODO" });
    const before = (await auditFor(t.id)).length;
    await expect(setTaskStatus(actor, t.id, "TODO")).rejects.toThrow(ValidationError);
    expect((await auditFor(t.id)).length).toBe(before);
  });
});

describe("moveTask", () => {
  it("maps a lane change to the lane's default status and audits TaskMoved", async () => {
    const t = await make({ title: `${RUN}-mv`, status: "TODO" });
    const moved = await moveTask(actor, t.id, { lane: "IN_PROGRESS" });
    expect(moved.status).toBe("IN_PROGRESS");

    const logs = await auditFor(t.id);
    expect(logs.map((l) => l.action)).toEqual(["TaskCreated", "TaskMoved"]);
    expect(logs[1].data).toMatchObject({
      fromStatus: "TODO",
      toStatus: "IN_PROGRESS",
      lane: "IN_PROGRESS",
    });
  });

  it("keeps a status that already belongs to the target lane (BLOCKED stays BLOCKED in IN_REVIEW)", async () => {
    const t = await make({ title: `${RUN}-blk`, status: "BLOCKED" });
    const moved = await moveTask(actor, t.id, { lane: "IN_REVIEW" });
    expect(moved.status).toBe("BLOCKED");
  });

  it("lands between the named neighbours", async () => {
    const a = await make({ title: `${RUN}-n1`, status: "TODO" });
    const b = await make({ title: `${RUN}-n2`, status: "TODO" });
    const c = await make({ title: `${RUN}-n3`, status: "DONE" });

    await moveTask(actor, c.id, { lane: "BACKLOG", afterId: a.id, beforeId: b.id });
    const [pa, pc, pb] = [await pos(a.id), await pos(c.id), await pos(b.id)];
    expect(pc.gt(pa)).toBe(true);
    expect(pc.lt(pb)).toBe(true);
    // A lane crossing: c was DONE → its status did not belong to BACKLOG, so it
    // took the lane default instead of keeping DONE.
    expect((await db.task.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      TASK_LANE_DEFAULT_STATUS.BACKLOG,
    );
  });

  it("refuses a neighbour that is not in the target lane — no write, no audit row", async () => {
    const inProgress = await make({ title: `${RUN}-ip`, status: "IN_PROGRESS" });
    const t = await make({ title: `${RUN}-mvref`, status: "DONE" });
    const before = (await auditFor(t.id)).length;
    await expect(
      moveTask(actor, t.id, { lane: "BACKLOG", afterId: inProgress.id }),
    ).rejects.toThrow(ValidationError);
    expect((await auditFor(t.id)).length).toBe(before);
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DONE");
  });

  it("a true no-op — same lane, same current neighbours — writes nothing", async () => {
    const a = await make({ title: `${RUN}-o1`, status: "TODO" });
    const b = await make({ title: `${RUN}-o2`, status: "TODO" });
    const c = await make({ title: `${RUN}-o3`, status: "TODO" });
    // b already sits between a and c in the TODO/backlog lane.
    const before = (await auditFor(b.id)).length;
    const result = await moveTask(actor, b.id, { lane: "BACKLOG", afterId: a.id, beforeId: c.id });
    expect(result.position.toString()).toBe(b.position.toString());
    expect((await auditFor(b.id)).length).toBe(before);
  });

  it("exhausted gaps rebalance the lane to 1..n and still land the card", async () => {
    const a = await make({ title: `${RUN}-r1`, status: "DONE" });
    const b = await make({ title: `${RUN}-r2`, status: "DONE" });
    const c = await make({ title: `${RUN}-r3`, status: "DONE" });
    // Force the gap under 1e-6: squeeze b hard against a.
    await db.task.update({
      where: { id: b.id },
      data: { position: (await pos(a.id)).add("0.0000005") },
    });

    await moveTask(actor, c.id, { lane: "DONE", afterId: a.id, beforeId: b.id });
    const [pa, pc, pb] = [await pos(a.id), await pos(c.id), await pos(b.id)];
    expect(pc.gt(pa)).toBe(true);
    expect(pc.lt(pb)).toBe(true);
    // The lane was renumbered: every unmoved DONE task now sits on an integer.
    const lane = await db.task.findMany({
      where: { status: "DONE", id: { not: c.id } },
      select: { position: true },
    });
    for (const t of lane) expect(t.position.mod(1).toString()).toBe("0");
  });

  it("refuses stale neighbours sent in the wrong order — no write, no audit row", async () => {
    const a = await make({ title: `${RUN}-s1`, status: "TODO" });
    const b = await make({ title: `${RUN}-s2`, status: "TODO" });
    const c = await make({ title: `${RUN}-s3`, status: "TODO" });
    // Stale board: the client means "after b, before a", but in the CURRENT
    // lane a already sits before b. Even after a rebalance there is no slot
    // between them, so the write is refused rather than landing unasked-for.
    const before = (await auditFor(c.id)).length;
    const err = await moveTask(actor, c.id, {
      lane: "BACKLOG",
      afterId: b.id,
      beforeId: a.id,
    }).then(
      () => {
        throw new Error("expected the stale-neighbour move to be refused");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).formErrors[0]).toMatch(/Spalte hat sich geändert/);
    expect((await auditFor(c.id)).length).toBe(before);
    const [pa, pb, pc] = [await pos(a.id), await pos(b.id), await pos(c.id)];
    expect(pa.lt(pb)).toBe(true);
    expect(pb.lt(pc)).toBe(true);
  });
});

describe("setTaskAssignees", () => {
  it("replaces the set, persists per-assignee estimates, audits {added, removed}", async () => {
    const u1 = await makeUser("u1");
    const u2 = await makeUser("u2");
    const t = await make({ title: `${RUN}-asg` });

    await setTaskAssignees(actor, t.id, [
      { userId: u1.id, estimateMinutes: 30 },
      { userId: u2.id },
    ]);
    let rows = await db.taskAssignees.findMany({
      where: { taskId: t.id },
      orderBy: { userId: "asc" },
    });
    const expected = [
      [u1.id, 30],
      [u2.id, null],
    ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
    expect(rows.map((r) => [r.userId, r.estimateMinutes])).toEqual(expected);

    await setTaskAssignees(actor, t.id, [{ userId: u2.id, estimateMinutes: 45 }]);
    rows = await db.taskAssignees.findMany({ where: { taskId: t.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(u2.id);
    expect(rows[0].estimateMinutes).toBe(45);

    const logs = await auditFor(t.id);
    const changed = logs.filter((l) => l.action === "TaskAssigneesChanged");
    expect(changed).toHaveLength(2);
    expect(changed[0].data).toMatchObject({ added: [u1.id, u2.id], removed: [] });
    expect(changed[1].data).toMatchObject({ added: [], removed: [u1.id] });
  });

  it("an identical set writes nothing; an unknown user refuses and audits nothing", async () => {
    const u = await makeUser("u3");
    const t = await make({ title: `${RUN}-asg2` });
    await setTaskAssignees(actor, t.id, [{ userId: u.id, estimateMinutes: 10 }]);
    const before = (await auditFor(t.id)).length;

    await setTaskAssignees(actor, t.id, [{ userId: u.id, estimateMinutes: 10 }]);
    expect((await auditFor(t.id)).length).toBe(before);

    await expect(setTaskAssignees(actor, t.id, [{ userId: `${RUN}-ghost` }])).rejects.toThrow(
      ValidationError,
    );
    expect((await auditFor(t.id)).length).toBe(before);
  });
});

describe("deleteTask", () => {
  it("refuses while subtasks exist — no write, no audit row", async () => {
    const parent = await make({ title: `${RUN}-dp` });
    const child = await make({ title: `${RUN}-dc`, parentTaskId: parent.id });

    const refused = await deleteTask(actor, parent.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).formErrors[0]).toMatch(/1 Unteraufgabe/);
    expect((await auditFor(parent.id)).map((l) => l.action)).toEqual(["TaskCreated"]);
    expect(await db.task.findUnique({ where: { id: parent.id } })).not.toBeNull();

    // Removing the child first (subtasks die with the tree going up, not down).
    await deleteTask(actor, child.id);
    await deleteTask(actor, parent.id);
    expect(await db.task.findUnique({ where: { id: parent.id } })).toBeNull();
    const logs = await auditFor(parent.id);
    expect(logs.at(-1)!.action).toBe("TaskDeleted");
  });

  it("dependency edges die with the task (Cascade) — counted in the audit row", async () => {
    const a = await make({ title: `${RUN}-e1` });
    const b = await make({ title: `${RUN}-e2` });
    await addTaskBlocker(actor, a.id, b.id); // a blocked by b

    await deleteTask(actor, a.id);
    expect(
      await db.taskDependency.count({ where: { blockedByTaskId: a.id, blockingTaskId: b.id } }),
    ).toBe(0);
    const logs = await auditFor(a.id);
    expect(logs.at(-1)!.data).toMatchObject({ dependencyEdges: 1 });
  });

  it("a missing task is a NotFoundError", async () => {
    await expect(deleteTask(actor, `${RUN}-gone`)).rejects.toThrow(NotFoundError);
  });
});

describe("task dependencies — the DAG invariants", () => {
  it("refuses a self-edge before even taking the lock — no audit row", async () => {
    const a = await make({ title: `${RUN}-s1` });
    const before = (await auditFor(a.id)).length;
    await expect(addTaskBlocker(actor, a.id, a.id)).rejects.toThrow(ValidationError);
    expect((await auditFor(a.id)).length).toBe(before);
  });

  it("refuses a duplicate edge — no second audit row", async () => {
    const a = await make({ title: `${RUN}-d1` });
    const b = await make({ title: `${RUN}-d2` });
    await addTaskBlocker(actor, a.id, b.id);
    const before = (await auditFor(a.id)).length;
    await expect(addTaskBlocker(actor, a.id, b.id)).rejects.toThrow(ValidationError);
    expect((await auditFor(a.id)).length).toBe(before);
  });

  it("refuses the edge on BOTH sides — a←b lands, b←a closes a 2-cycle", async () => {
    const a = await make({ title: `${RUN}-c1` });
    const b = await make({ title: `${RUN}-c2` });
    await addTaskBlocker(actor, a.id, b.id); // a blocked by b
    const before = (await auditFor(b.id)).length;
    await expect(addTaskBlocker(actor, b.id, a.id)).rejects.toThrow(ValidationError);
    expect((await auditFor(b.id)).length).toBe(before);
    expect(
      await db.taskDependency.count({ where: { blockedByTaskId: b.id, blockingTaskId: a.id } }),
    ).toBe(0);
  });

  it("refuses the edge that closes a THREE-node cycle (a←b←c, then c←a)", async () => {
    const a = await make({ title: `${RUN}-t1` });
    const b = await make({ title: `${RUN}-t2` });
    const c = await make({ title: `${RUN}-t3` });
    await addTaskBlocker(actor, a.id, b.id); // a blocked by b
    await addTaskBlocker(actor, b.id, c.id); // b blocked by c → c transitively blocks a

    const before = (await auditFor(c.id)).length;
    await expect(addTaskBlocker(actor, c.id, a.id)).rejects.toThrow(ValidationError);
    expect((await auditFor(c.id)).length).toBe(before);
    expect(
      await db.taskDependency.count({ where: { blockedByTaskId: c.id, blockingTaskId: a.id } }),
    ).toBe(0);
  });

  it("removeTaskBlocker drops the edge and audits on the blocked task; removing a non-edge refuses", async () => {
    const a = await make({ title: `${RUN}-r1` });
    const b = await make({ title: `${RUN}-r2` });
    await addTaskBlocker(actor, a.id, b.id);
    await removeTaskBlocker(actor, a.id, b.id);
    expect(
      await db.taskDependency.count({ where: { blockedByTaskId: a.id, blockingTaskId: b.id } }),
    ).toBe(0);
    expect((await auditFor(a.id)).map((l) => l.action)).toEqual([
      "TaskCreated",
      "TaskBlockerAdded",
      "TaskBlockerRemoved",
    ]);

    const before = (await auditFor(a.id)).length;
    await expect(removeTaskBlocker(actor, a.id, b.id)).rejects.toThrow(ValidationError);
    expect((await auditFor(a.id)).length).toBe(before);
  });
});

describe("task schema — labels (repeated form keys, normalised in-schema)", () => {
  it("trims, drops blanks, dedupes — one blank box never rejects the save", () => {
    const p = (labels: unknown) => taskCreateSchema.safeParse({ title: "x", labels }).data!.labels;
    expect(p(["kabel", "  ", "kabel", " hdmi "])).toEqual(["kabel", "hdmi"]);
    expect(p("kabel")).toEqual(["kabel"]); // a SINGLE input arrives as a bare string
    expect(p([""])).toEqual([]); // one blank box → empty list, not a rejection
    expect(p(undefined)).toEqual([]);
  });
});

describe("listTasks + listBoardTasks", () => {
  it("filters by label, text, statuses, assignee, project and due window", async () => {
    const u = await makeUser("flt");
    const project = await db.project.create({ data: { name: `${RUN} P`, slug: `${RUN}-p` } });
    try {
      const tagged = await make({
        title: `${RUN}-tagged`,
        labels: ["w2-label"],
        projectId: project.id,
      });
      await setTaskAssignees(actor, tagged.id, [{ userId: u.id }]);
      await make({ title: `${RUN}-other` });
      const dueSoon = await make({ title: `${RUN}-due`, dueAt: new Date("2026-12-01") });

      const byLabel = await listTasks({ label: "w2-label" });
      expect(byLabel.map((t) => t.id)).toContain(tagged.id);
      expect(byLabel.map((t) => t.id)).not.toContain(dueSoon.id);

      const byQ = await listTasks({ q: `${RUN}-tagged` });
      expect(byQ.map((t) => t.id)).toEqual([tagged.id]);

      const byStatus = await listTasks({ statuses: ["DONE"], q: RUN });
      expect(byStatus.map((t) => t.id)).not.toContain(tagged.id);
      await setTaskStatus(actor, tagged.id, "DONE");
      const doneNow = await listTasks({ statuses: ["DONE"], q: RUN });
      expect(doneNow.map((t) => t.id)).toContain(tagged.id);

      const byAssignee = await listTasks({ assigneeId: u.id });
      expect(byAssignee.map((t) => t.id)).toContain(tagged.id);

      const byProject = await listTasks({ projectId: project.id });
      expect(byProject.map((t) => t.id)).toEqual([tagged.id]);

      const byDue = await listTasks({
        dueFrom: new Date("2026-11-01"),
        dueTo: new Date("2026-12-31"),
      });
      expect(byDue.map((t) => t.id)).toContain(dueSoon.id);
      expect(byDue.map((t) => t.id)).not.toContain(tagged.id);
    } finally {
      await db.project.delete({ where: { id: project.id } }).catch(() => undefined);
    }
  });

  it("orders lane → position → id and computes isBlocked from blocker status", async () => {
    const blocked = await make({ title: `${RUN}-b1`, status: "TODO" });
    const blocker = await make({ title: `${RUN}-b2`, status: "IN_PROGRESS" });
    await addTaskBlocker(actor, blocked.id, blocker.id);

    let board = await listBoardTasks({});
    const row = board.find((t) => t.id === blocked.id)!;
    expect(row.lane).toBe("BACKLOG");
    expect(row.isBlocked).toBe(true);

    // A blocker that is DONE or CANCELLED does not block.
    await setTaskStatus(actor, blocker.id, "DONE");
    board = await listBoardTasks({});
    expect(board.find((t) => t.id === blocked.id)!.isBlocked).toBe(false);

    // Ordering: lanes appear in LANES order; inside a lane, position asc then id.
    for (let i = 1; i < board.length; i++) {
      const [pa, pb] = [board[i - 1], board[i]];
      const laneOrder = LANES.indexOf(pa.lane) - LANES.indexOf(pb.lane);
      if (laneOrder !== 0) {
        expect(laneOrder).toBeLessThan(0);
      } else {
        const position = pa.position.comparedTo(pb.position);
        expect(position < 0 || (position === 0 && pa.id <= pb.id)).toBe(true);
      }
    }
  });
});
