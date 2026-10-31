import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { deriveSlug } from "~/lib/slug.server";
import {
  createProject,
  deleteProject,
  setProjectStatus,
  updateProject,
} from "~/domains/projects/projects.mutations.server";
import { listProjects } from "~/domains/projects/projects.queries.server";
import type { ProjectCreateInput, ProjectEditInput } from "~/domains/projects/projects.schema";

/**
 * Project mutation guards, one per acceptance criterion — the
 * `locations.mutations.test.ts` shape, one folder over:
 *
 *   - every mutation runs through `txWithAudit` and writes its ActivityLog row
 *     in the same transaction                            → the "exactly one row" tests
 *   - a REFUSED mutation (cycle, delete-with-children, same status, unknown FK)
 *     writes no ActivityLog row and no state change      → the refusal tests
 *   - `deleteProject` detaches tasks/events/notes via SetNull and puts their
 *     counts in the audit row                            → the delete test
 *
 * ActivityLog is append-only, so nothing here deletes audit rows; every
 * assertion is scoped to the ids this file created.
 */

const RUN = `proj_${Date.now().toString(36)}`;
const actor = { id: null, name: "Project Tester", initials: "PT" };

/** Created children-before-parents so afterAll can unwind in reverse (Restrict). */
const createdIds: string[] = [];
const taskIds: string[] = [];

afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  for (const id of [...createdIds].reverse()) {
    await db.project.delete({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

function input(over: Partial<ProjectCreateInput> & { name: string }): ProjectCreateInput {
  return {
    description: undefined,
    status: "REQUESTED",
    color: undefined,
    startAt: undefined,
    dueAt: undefined,
    leadId: undefined,
    parentProjectId: undefined,
    ...over,
  };
}

async function make(over: Partial<ProjectCreateInput> & { name: string }) {
  const project = await createProject(actor, input(over));
  createdIds.push(project.id);
  return project;
}

/** Every audit row this file's entity produced, in order. */
function auditFor(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "project", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

describe("project mutations — create", () => {
  it("writes exactly one ProjectCreated row, and the slug derives from the name", async () => {
    const p = await make({ name: `${RUN} Hörsaal Süd`, status: "CONFIRMED" });
    expect(p.slug).toBe(deriveSlug(`${RUN} Hörsaal Süd`));
    expect(p.slug).toContain("hoersaal-sued");

    const logs = await auditFor(p.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("ProjectCreated");
    expect((logs[0].data as Record<string, unknown>).slug).toBe(p.slug);
  });

  it("derives a UNIQUE slug on collision — the second same-named project gets -2", async () => {
    const a = await make({ name: `${RUN} Dup` });
    const b = await make({ name: `${RUN} Dup` });
    expect(b.slug).not.toBe(a.slug);
    expect(b.slug.endsWith("-2")).toBe(true);
  });

  it("refuses an unknown parentProjectId or leadId — and writes no audit row", async () => {
    const before = await db.activityLog.count({ where: { entityType: "project" } });
    await expect(
      make({ name: `${RUN}-badparent`, parentProjectId: `${RUN}-nope` }),
    ).rejects.toThrow(ValidationError);
    await expect(make({ name: `${RUN}-badlead`, leadId: `${RUN}-nope` })).rejects.toThrow(
      ValidationError,
    );
    expect(await db.activityLog.count({ where: { entityType: "project" } })).toBe(before);
  });
});

describe("project mutations — update + reparent", () => {
  it("update changes content fields and keeps the slug stable across a rename", async () => {
    const p = await make({ name: `${RUN}-rename-me` });
    const updated = await updateProject(actor, p.id, {
      id: p.id,
      name: `${RUN}-renamed`,
      description: "neu",
      color: "#123456",
      startAt: null,
      dueAt: null,
      leadId: undefined,
      parentProjectId: undefined,
    } satisfies ProjectEditInput);
    expect(updated.name).toBe(`${RUN}-renamed`);
    expect(updated.slug).toBe(p.slug);
    expect((await auditFor(p.id)).map((l) => l.action)).toEqual([
      "ProjectCreated",
      "ProjectUpdated",
    ]);
  });

  it("refuses parent = self and parent = a descendant — with no audit row", async () => {
    const root = await make({ name: `${RUN}-root` });
    const child = await make({ name: `${RUN}-child`, parentProjectId: root.id });
    const grand = await make({ name: `${RUN}-grand`, parentProjectId: child.id });

    const edit = (over: Partial<ProjectEditInput>): ProjectEditInput => ({
      id: root.id,
      name: root.name,
      description: undefined,
      color: undefined,
      startAt: null,
      dueAt: null,
      leadId: undefined,
      parentProjectId: undefined,
      ...over,
    });

    const before = (await auditFor(root.id)).length;
    await expect(updateProject(actor, root.id, edit({ parentProjectId: root.id }))).rejects.toThrow(
      ValidationError,
    );
    // Descendant: `grand` sits strictly below `root` — the recursive CTE refuses it.
    await expect(
      updateProject(actor, root.id, edit({ parentProjectId: grand.id })),
    ).rejects.toThrow(ValidationError);
    expect((await auditFor(root.id)).length).toBe(before);
    expect((await db.project.findUnique({ where: { id: root.id } }))?.parentProjectId).toBeNull();
  });
});

describe("project mutations — status + delete", () => {
  it("setProjectStatus writes ProjectStatusChanged {from,to}; the same status is refused", async () => {
    const p = await make({ name: `${RUN}-status`, status: "REQUESTED" });
    await setProjectStatus(actor, p.id, "CONFIRMED");

    const logs = await auditFor(p.id);
    expect(logs.map((l) => l.action)).toEqual(["ProjectCreated", "ProjectStatusChanged"]);
    expect(logs[1].data).toMatchObject({ from: "REQUESTED", to: "CONFIRMED" });

    const before = logs.length;
    await expect(setProjectStatus(actor, p.id, "CONFIRMED")).rejects.toThrow(ValidationError);
    expect((await auditFor(p.id)).length).toBe(before);
  });

  it("delete refuses while sub-projects exist, then detaches tasks and names the counts", async () => {
    const parent = await make({ name: `${RUN}-del-parent` });
    const child = await make({ name: `${RUN}-del-child`, parentProjectId: parent.id });

    const before = (await auditFor(parent.id)).length;
    // ValidationError.message is "Validation failed" — the count lives in formErrors.
    const refused = await deleteProject(actor, parent.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).formErrors[0]).toMatch(/1 Teilprojekt/);
    expect((await auditFor(parent.id)).length).toBe(before);

    // Detach the child, attach a task — the delete must carry the detach count.
    await updateProject(actor, child.id, {
      id: child.id,
      name: child.name,
      description: undefined,
      color: undefined,
      startAt: null,
      dueAt: null,
      leadId: undefined,
      parentProjectId: undefined,
    });
    const task = await db.task.create({ data: { title: `${RUN}-task`, projectId: parent.id } });
    taskIds.push(task.id);

    await deleteProject(actor, parent.id);
    expect(await db.project.findUnique({ where: { id: parent.id } })).toBeNull();
    // SetNull, not Cascade: the task survived and lost its container.
    expect((await db.task.findUnique({ where: { id: task.id } }))?.projectId).toBeNull();

    const logs = await auditFor(parent.id);
    const deleted = logs.find((l) => l.action === "ProjectDeleted");
    expect(deleted?.data).toMatchObject({ detachedTotal: 1, detached: { tasks: 1 } });
  });

  it("delete on a missing project is a NotFoundError, not a crash", async () => {
    await expect(deleteProject(actor, `${RUN}-gone`)).rejects.toThrow(NotFoundError);
  });
});

describe("project queries — listProjects task counts", () => {
  it("counts open/done/total per project, CANCELLED counting as settled-not-done", async () => {
    const p = await make({ name: `${RUN}-counts` });
    const mk = async (status: "TODO" | "DONE" | "CANCELLED" | "IN_PROGRESS") => {
      const t = await db.task.create({
        data: { title: `${RUN}-${status}`, status, projectId: p.id },
      });
      taskIds.push(t.id);
    };
    await mk("TODO");
    await mk("IN_PROGRESS");
    await mk("DONE");
    await mk("CANCELLED");

    const row = (await listProjects({ q: `${RUN}-counts` })).find((r) => r.id === p.id);
    expect(row?.tasks).toEqual({ total: 4, open: 2, done: 1 });
  });
});
