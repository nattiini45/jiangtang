import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { createTask, moveTask, setTaskStatus } from "~/domains/tasks/tasks.mutations.server";
import { createProject, setProjectStatus } from "~/domains/projects/projects.mutations.server";
import { taskCreateSchema } from "~/domains/tasks/tasks.schema";
import { projectCreateSchema } from "~/domains/projects/projects.schema";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { addTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { importTasksInTx } from "~/domains/tasks/tasks.transfer.server";
import { importProjectsInTx } from "~/domains/projects/projects.transfer.server";
import {
  LANES,
  LANE_TASK_STATUSES,
  TASK_LANE_DEFAULT_STATUS,
  laneOfTaskStatus,
} from "~/domains/tasks/tasks.lanes";

const actor = { id: null, name: "Synthetic work characterization" };
const taskStates = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELLED",
] as const;
const projectStates = [
  "REQUESTED",
  "CONFIRMED",
  "AWAITING_FEEDBACK",
  "CONSULTATION_SCHEDULED",
  "COMPLETED",
  "FOLLOW_UP_REQUIRED",
  "REJECTED",
  "CANCELLED",
] as const;
const taskIds: string[] = [];
const projectIds: string[] = [];
const userIds: string[] = [];
const logs = (entityType: string, entityId: string) =>
  db.activityLog.findMany({ where: { entityType, entityId }, orderBy: { occurredAt: "asc" } });
const listed = async (id: string) => (await listTasks()).find((row) => row.id === id);
async function task(status: (typeof taskStates)[number]) {
  const row = await createTask(
    actor,
    taskCreateSchema.parse({ title: `Synthetic ${status}`, status }),
  );
  taskIds.push(row.id);
  return row;
}
async function project(status: (typeof projectStates)[number]) {
  const row = await createProject(
    actor,
    projectCreateSchema.parse({ name: `Synthetic ${status}`, status }),
  );
  projectIds.push(row.id);
  return row;
}
afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("task lifecycle characterization", () => {
  for (const from of taskStates) {
    it(`${from}: creation accepts the state and audits exactly once`, async () => {
      const row = await task(from);
      expect(row.status).toBe(from);
      expect(await logs("task", row.id)).toMatchObject([
        {
          action: "TaskCreated",
          data: { title: row.title, status: from, position: row.position.toString() },
        },
      ]);
    });
    for (const to of taskStates) {
      it(`${from} → ${to}: exact status, position and audit semantics`, async () => {
        const before = await task(from);
        const prior = await logs("task", before.id);
        if (from === to) {
          await expect(setTaskStatus(actor, before.id, to)).rejects.toBeInstanceOf(ValidationError);
          expect(await db.task.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
          expect(await logs("task", before.id)).toEqual(prior);
          return;
        }
        const tail = await db.task.findFirst({
          where: { status: { in: LANE_TASK_STATUSES[laneOfTaskStatus(to)] } },
          orderBy: [{ position: "desc" }, { id: "desc" }],
        });
        const after = await setTaskStatus(actor, before.id, to);
        expect(after).toEqual({
          ...before,
          status: to,
          position: tail ? tail.position.add(1) : expect.anything(),
          updatedAt: expect.any(Date),
        });
        expect(after.position.toString()).toBe(tail ? tail.position.add(1).toString() : "1");
        const audit = await logs("task", before.id);
        expect(audit).toHaveLength(prior.length + 1);
        expect(audit.at(-1)).toMatchObject({
          action: "TaskStatusChanged",
          data: { title: before.title, from, to },
        });
        expect(audit.at(-1)!.data).toEqual({ title: before.title, from, to });
      });
    }
    for (const lane of LANES) {
      it(`${from} board → ${lane}: preserves within-lane status or uses the lane default`, async () => {
        const before = await task(from);
        const a = await task(TASK_LANE_DEFAULT_STATUS[lane]);
        const b = await task(TASK_LANE_DEFAULT_STATUS[lane]);
        const after = await moveTask(actor, before.id, { lane, afterId: a.id, beforeId: b.id });
        const expected = laneOfTaskStatus(from) === lane ? from : TASK_LANE_DEFAULT_STATUS[lane];
        expect(after.status).toBe(expected);
        expect(after.position.gt(a.position) && after.position.lt(b.position)).toBe(true);
        const audit = await logs("task", before.id);
        expect(audit).toHaveLength(2);
        expect(audit[1].action).toBe("TaskMoved");
        expect(audit[1].data).toEqual({
          title: before.title,
          fromStatus: from,
          toStatus: expected,
          lane,
          position: after.position.toString(),
        });
        expect(await moveTask(actor, before.id, { lane, afterId: a.id, beforeId: b.id })).toEqual(
          after,
        );
        expect(await logs("task", before.id)).toEqual(audit);
      });
    }
  }
  it("manual BLOCKED and dependency-derived isBlocked remain independent even for completed work", async () => {
    const manual = await task("BLOCKED");
    expect((await listed(manual.id))?.isBlocked).toBe(false);
    const blocked = await task("BACKLOG");
    const blocker = await task("TODO");
    await addTaskBlocker(actor, blocked.id, blocker.id);
    expect(await listed(blocked.id)).toMatchObject({ status: "BACKLOG", isBlocked: true });
    await setTaskStatus(actor, blocked.id, "DONE");
    expect(await listed(blocked.id)).toMatchObject({ status: "DONE", isBlocked: true });
    await setTaskStatus(actor, blocker.id, "CANCELLED");
    expect(await listed(blocked.id)).toMatchObject({ status: "DONE", isBlocked: false });
    await setTaskStatus(actor, blocker.id, "TODO");
    expect(await listed(blocked.id)).toMatchObject({ status: "DONE", isBlocked: true });
  });
});

describe("project lifecycle characterization", () => {
  for (const from of projectStates) {
    it(`${from}: creation accepts the state and audits exactly once`, async () => {
      const row = await project(from);
      expect(row.status).toBe(from);
      const audit = await logs("project", row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "ProjectCreated",
        data: { name: row.name, slug: row.slug, status: from },
      });
    });
    for (const to of projectStates) {
      it(`${from} → ${to}: exact status and audit semantics`, async () => {
        const before = await project(from);
        const prior = await logs("project", before.id);
        if (from === to) {
          await expect(setProjectStatus(actor, before.id, to)).rejects.toBeInstanceOf(
            ValidationError,
          );
          expect(await db.project.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
          expect(await logs("project", before.id)).toEqual(prior);
          return;
        }
        expect(await setProjectStatus(actor, before.id, to)).toEqual({
          ...before,
          status: to,
          updatedAt: expect.any(Date),
        });
        const audit = await logs("project", before.id);
        expect(audit).toHaveLength(2);
        expect(audit[1].action).toBe("ProjectStatusChanged");
        expect(audit[1].data).toEqual({ name: before.name, from, to });
      });
    }
  }
  it("closing a project does not mutate children or contained tasks", async () => {
    const parent = await project("REQUESTED");
    const child = await project("CONFIRMED");
    const work = await task("TODO");
    await db.project.update({ where: { id: child.id }, data: { parentProjectId: parent.id } });
    await db.task.update({ where: { id: work.id }, data: { projectId: parent.id } });
    await setProjectStatus(actor, parent.id, "COMPLETED");
    expect(await db.project.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      status: "CONFIRMED",
    });
    expect(await db.task.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({
      status: "TODO",
    });
    await setTaskStatus(actor, work.id, "DONE");
    await setTaskStatus(actor, work.id, "BACKLOG");
    await db.project.update({ where: { id: child.id }, data: { parentProjectId: null } });
  });
});

it("workspace restore replaces content, status and assignees but retains existing position and import audit verbs", async () => {
  const existing = await task("TODO");
  const container = await project("REQUESTED");
  const user = await db.user.create({
    data: { email: `restore-${existing.id}@test.local`, name: "Synthetic restore assignee" },
  });
  userIds.push(user.id);
  await db.taskAssignees.create({ data: { taskId: existing.id, userId: user.id } });
  const taskRow = {
    id: existing.id,
    title: "Synthetic restored content",
    body: "restored",
    status: "DONE" as const,
    priority: null,
    startAt: null,
    dueAt: null,
    estimateMinutes: null,
    labels: [],
    projectSlug: container.slug,
    parentTaskId: null,
    assignees: [],
    blockedBy: [],
  };
  const projectRow = {
    id: container.id,
    slug: container.slug,
    name: "Synthetic restored project",
    description: "restored",
    status: "CANCELLED" as const,
    color: null,
    startAt: null,
    dueAt: null,
    leadEmail: null,
    parentSlug: null,
  };
  await txWithAudit(actor, async (tx, audit) => {
    await importProjectsInTx(tx, audit, actor, [projectRow]);
    await importTasksInTx(
      tx,
      audit,
      actor,
      [taskRow],
      new Map([[container.slug, container.id]]),
      new Map(),
    );
  });
  expect(
    await db.task.findUniqueOrThrow({ where: { id: existing.id }, include: { assignees: true } }),
  ).toMatchObject({
    title: taskRow.title,
    status: "DONE",
    position: existing.position,
    assignees: [],
  });
  expect((await logs("task", existing.id)).map(({ action, data }) => ({ action, data }))).toEqual([
    {
      action: "TaskCreated",
      data: { title: existing.title, status: "TODO", position: existing.position.toString() },
    },
    { action: "TaskUpdated", data: { title: taskRow.title, status: "DONE", viaImport: true } },
  ]);
  expect(await db.project.findUniqueOrThrow({ where: { id: container.id } })).toMatchObject({
    name: projectRow.name,
    status: "CANCELLED",
    slug: container.slug,
  });
  expect((await logs("project", container.id)).at(-1)).toMatchObject({
    action: "ProjectUpdated",
    data: { name: projectRow.name, slug: container.slug, viaImport: true },
  });
});
