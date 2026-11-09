import { afterAll, describe, expect, it } from "vitest";
import { TaskStatus, ProjectStatus } from "~/generated/prisma/enums";
import { db } from "~/lib/db.server";
import { TransitionError } from "~/lib/errors.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { createTask, moveTask, setTaskStatus } from "~/domains/tasks/tasks.mutations.server";
import { createProject, setProjectStatus } from "~/domains/projects/projects.mutations.server";
import { TASK_TRANSITIONS, taskActionMetadata } from "~/domains/tasks/tasks.transitions";
import {
  PROJECT_TRANSITIONS,
  projectActionMetadata,
} from "~/domains/projects/projects.transitions";

const actor = { id: null, name: "Synthetic work transition verification" };
const taskIds: string[] = [];
const projectIds: string[] = [];
const logs = (entityType: string, entityId: string) =>
  db.activityLog.findMany({ where: { entityType, entityId } });
async function task() {
  const row = await createTask(actor, {
    title: "Synthetic concurrent task",
    status: "TODO",
    labels: [],
  });
  taskIds.push(row.id);
  return row;
}
async function project() {
  const row = await createProject(actor, {
    name: "Synthetic concurrent project",
    status: "REQUESTED",
  });
  projectIds.push(row.id);
  return row;
}
afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
});

describe("work transition tables", () => {
  it("exhaustively projects every non-self enum pair and localized label without completion gates", () => {
    for (const [states, graph, metadata] of [
      [Object.values(TaskStatus), TASK_TRANSITIONS, taskActionMetadata],
      [Object.values(ProjectStatus), PROJECT_TRANSITIONS, projectActionMetadata],
    ] as const) {
      expect(Object.keys(graph).sort()).toEqual([...states].sort());
      for (const state of states) {
        const projected = (metadata as (status: string) => ReturnType<typeof taskActionMetadata>)(
          state,
        );
        expect(projected.allowedTransitions).toEqual(states.filter((target) => target !== state));
        expect(projected.allowedActions).toHaveLength(states.length - 1);
        for (const action of projected.allowedActions) {
          expect(action).toMatchObject({ allowed: true, requiredFields: [] });
          for (const locale of ["en", "de"] as const)
            expect(t(locale, action.labelKey)).not.toBe(action.labelKey);
        }
      }
    }
  });
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: rejected status writes return current-state metadata and leave row and audit unchanged`, async () => {
      const work = await task();
      const container = await project();
      for (const kind of ["task", "project"] as const) {
        const row = kind === "task" ? work : container;
        const prior = await logs(kind, row.id);
        const error = await runWithLocale(locale, () =>
          (kind === "task"
            ? setTaskStatus(actor, work.id, "TODO")
            : setProjectStatus(actor, container.id, "REQUESTED")
          ).catch((error: unknown) => error),
        );
        expect(error).toBeInstanceOf(TransitionError);
        expect((error as TransitionError).transition).toEqual({
          entity: kind,
          currentState: row.status,
          attemptedTarget: row.status,
          ...(kind === "task"
            ? taskActionMetadata(work.status)
            : projectActionMetadata(container.status)),
          reason: {
            code: "INVALID_TRANSITION",
            message: t(
              locale,
              kind === "task" ? "work.err.task.statusAlready" : "work.err.project.statusAlready",
            ),
          },
        });
        expect(await logs(kind, row.id)).toEqual(prior);
        expect(
          kind === "task"
            ? await db.task.findUniqueOrThrow({ where: { id: row.id } })
            : await db.project.findUniqueOrThrow({ where: { id: row.id } }),
        ).toEqual(row);
      }
    });
  }
});

async function race(kind: "task" | "project", id: string, mutations: (() => Promise<unknown>)[]) {
  let ready!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.$transaction(
    async (tx) => {
      if (kind === "task") await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${id} FOR UPDATE`;
      ready();
      await gate;
    },
    { timeout: 15000 },
  );
  await locked;
  const pending = Promise.allSettled(mutations.map((mutate) => mutate()));
  try {
    await expect
      .poll(
        async () => {
          const rows = await db.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${kind === "task" ? "Task" : "Project"}%`}`;
          return Number(rows[0].count);
        },
        { timeout: 10000, interval: 20 },
      )
      .toBe(2);
  } finally {
    release();
    await holder;
  }
  return pending;
}

describe("work transitions enforce actual current state under contention", () => {
  for (const kind of ["task", "project"] as const) {
    it(`${kind}: two same-target status sets write exactly once and reject the loser with its new current state`, async () => {
      const row = kind === "task" ? await task() : await project();
      const target = kind === "task" ? "DONE" : "COMPLETED";
      const mutate = () =>
        kind === "task"
          ? setTaskStatus(actor, row.id, "DONE")
          : setProjectStatus(actor, row.id, "COMPLETED");
      const results = await race(kind, row.id, [mutate, mutate]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(TransitionError);
      expect(rejected?.reason.transition).toMatchObject({
        currentState: target,
        attemptedTarget: target,
      });
      const audit = await logs(kind, row.id);
      expect(audit).toHaveLength(2);
      expect(audit.find((entry) => entry.action.endsWith("StatusChanged"))?.data).toMatchObject({
        from: row.status,
        to: target,
      });
    });
    it(`${kind}: different targets both succeed and audit a real serial state chain`, async () => {
      const row = kind === "task" ? await task() : await project();
      const targets = kind === "task" ? ["DONE", "IN_PROGRESS"] : ["COMPLETED", "CONFIRMED"];
      const results = await race(
        kind,
        row.id,
        kind === "task"
          ? [
              () => setTaskStatus(actor, row.id, "DONE"),
              () => setTaskStatus(actor, row.id, "IN_PROGRESS"),
            ]
          : [
              () => setProjectStatus(actor, row.id, "COMPLETED"),
              () => setProjectStatus(actor, row.id, "CONFIRMED"),
            ],
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const changes = (await logs(kind, row.id))
        .filter((entry) => entry.action.endsWith("StatusChanged"))
        .map((entry) => entry.data as { from: string; to: string });
      expect(changes).toHaveLength(2);
      const first = changes.find((entry) => entry.from === row.status)!;
      const second = changes.find((entry) => entry !== first)!;
      expect(targets).toContain(first.to);
      expect(second.from).toBe(first.to);
      expect(second.to).not.toBe(first.to);
    });
  }
  it("task board moves and status sets share current-state enforcement without locking before rebalance", async () => {
    const row = await task();
    const previous = await createTask(actor, {
      title: "Synthetic rebalance previous",
      status: "DONE",
      labels: [],
    });
    const next = await createTask(actor, {
      title: "Synthetic rebalance next",
      status: "DONE",
      labels: [],
    });
    taskIds.push(previous.id, next.id);
    await db.task.update({
      where: { id: next.id },
      data: { position: previous.position.add("0.0000005") },
    });
    const results = await race("task", row.id, [
      () => moveTask(actor, row.id, { lane: "DONE", afterId: previous.id, beforeId: next.id }),
      () => setTaskStatus(actor, row.id, "IN_PROGRESS"),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const audit = await logs("task", row.id);
    const moved = audit.find((entry) => entry.action === "TaskMoved")!.data as {
      fromStatus: string;
      toStatus: string;
    };
    const changed = audit.find((entry) => entry.action === "TaskStatusChanged")!.data as {
      from: string;
      to: string;
    };
    expect(moved.toStatus).toBe("DONE");
    expect(changed.to).toBe("IN_PROGRESS");
    expect(moved.fromStatus === "TODO" ? changed.from : moved.fromStatus).toBe(
      moved.fromStatus === "TODO" ? "DONE" : "IN_PROGRESS",
    );
    expect(audit).toHaveLength(3);
  });
});
