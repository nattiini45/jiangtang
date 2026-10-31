import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { PrismaClient } from "~/generated/prisma/client";
import { ValidationError } from "~/lib/errors.server";
import type { AuditActor } from "~/lib/audit.server";
import { createProject, deleteProject } from "~/domains/projects/projects.mutations.server";
import { createTask, deleteTask } from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { createNote, deleteNote } from "~/domains/notes/notes.mutations.server";
import { exportWorkspace } from "~/domains/transfer/export.server";
import { importWorkspace } from "~/domains/transfer/transfer.server";
import { workspaceTransferSchema } from "~/domains/transfer/transfer.schema";

/**
 * Round-trip and refusal tests. The round trip is the acceptance criterion:
 * export → wipe the exported rows through the domain deletes → import → the
 * same projects/tasks/notes/edges/assignees exist, with the same ids.
 * Refusals are asserted all-or-nothing: a refused import leaves no rows.
 *
 * ActivityLog is append-only; assertions are scoped to this file's ids.
 */

const RUN = `xfer_${Date.now().toString(36)}`;
const actor: AuditActor = { id: null, name: "Transfer Tester", initials: "XT" };

const projectIds: string[] = [];
const taskIds: string[] = [];
const noteIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const id of [...taskIds].reverse()) {
    await db.task.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of [...noteIds].reverse()) {
    await db.note.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of [...projectIds].reverse()) {
    await db.project.delete({ where: { id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

/** A cuid-shaped string (`c` + 24 lowercase alnum) for synthetic import docs. */
function cid(tag: string): string {
  const body = (RUN + tag).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `c${body.padEnd(24, "0").slice(0, 24)}`;
}

describe("workspace transfer", () => {
  it("round-trips: export → wipe → import restores rows, assignees and edges", async () => {
    const user = await db.user.create({
      data: { email: `${RUN}-a@test.local`, name: `${RUN} A`, initials: "XA" },
    });
    userIds.push(user.id);
    const authed: AuditActor = { id: user.id, name: user.name, initials: user.initials };
    // A real location from the seeded workspace: note locationId must survive
    // the transfer, not just the ID fields.
    const location = await db.location.findFirstOrThrow({ select: { id: true } });

    const parent = await createProject(authed, {
      name: `${RUN} Parent`,
      description: "P",
      status: "CONFIRMED",
      color: "#123456",
      startAt: undefined,
      dueAt: undefined,
      leadId: undefined,
      parentProjectId: undefined,
    });
    const childDueAt = new Date("2026-11-15T12:00:00.000Z");
    const child = await createProject(authed, {
      name: `${RUN} Child`,
      description: undefined,
      status: "REQUESTED",
      color: undefined,
      startAt: undefined,
      dueAt: childDueAt,
      leadId: user.id,
      parentProjectId: parent.id,
    });
    projectIds.push(parent.id, child.id);

    const blockerStartAt = new Date("2026-10-01T08:00:00.000Z");
    const blockerDueAt = new Date("2026-10-02T17:30:00.000Z");
    const blocker = await createTask(
      authed,
      {
        title: `${RUN} blocker`,
        status: "IN_PROGRESS",
        estimateMinutes: 90,
        projectId: child.id,
        labels: ["round", "trip"],
        body: undefined,
        priority: "HIGH",
        startAt: blockerStartAt,
        dueAt: blockerDueAt,
        parentTaskId: undefined,
        locationId: undefined,
      },
      // Per-assignee estimate share — the import must carry it across.
      [{ userId: user.id, estimateMinutes: 45 }],
    );
    const blocked = await createTask(authed, {
      title: `${RUN} blocked`,
      status: "BACKLOG",
      projectId: child.id,
      parentTaskId: blocker.id,
      labels: [],
      body: undefined,
      priority: undefined,
      startAt: undefined,
      dueAt: undefined,
      estimateMinutes: undefined,
      locationId: undefined,
    });
    taskIds.push(blocker.id, blocked.id);
    await addTaskBlocker(authed, blocked.id, blocker.id);

    const note = await createNote(authed, {
      title: `${RUN} note`,
      body: "# hi",
      tags: ["tag1"],
      pinned: true,
      projectId: parent.id,
      locationId: location.id,
    });
    noteIds.push(note.id);

    // Export, then slice to this fixture — the export contains the whole
    // workspace; wiping other slices' rows is not this test's business.
    const exported = await exportWorkspace();
    const fixtureIds = new Set([...projectIds, ...taskIds, ...noteIds]);
    // Raw JSON with no parse/transform before importing.
    const doc = {
      ...exported,
      projects: exported.projects.filter((p) => fixtureIds.has(p.id)),
      tasks: exported.tasks.filter((t) => fixtureIds.has(t.id)),
      notes: exported.notes.filter((n) => fixtureIds.has(n.id)),
    };
    expect(doc.projects).toHaveLength(2);
    expect(doc.tasks).toHaveLength(2);
    expect(doc.notes).toHaveLength(1);
    expect(doc.tasks.find((t) => t.id === blocked.id)?.blockedBy).toEqual([blocker.id]);
    expect(doc.tasks.find((t) => t.id === blocked.id)?.parentTaskId).toBe(blocker.id);
    expect(doc.tasks.find((t) => t.id === blocker.id)?.assignees).toEqual([
      { email: user.email, estimateMinutes: 45 },
    ]);
    expect(doc.projects.find((p) => p.id === child.id)?.parentSlug).toBe(parent.slug);
    expect(doc.projects.find((p) => p.id === child.id)?.leadEmail).toBe(user.email);
    expect(doc.projects.find((p) => p.id === child.id)?.dueAt).toBe(childDueAt.toISOString());
    expect(doc.tasks.find((t) => t.id === blocker.id)?.startAt).toBe(blockerStartAt.toISOString());
    expect(doc.tasks.find((t) => t.id === blocker.id)?.dueAt).toBe(blockerDueAt.toISOString());
    expect(doc.notes.find((n) => n.id === note.id)?.locationId).toBe(location.id);

    // Wipe: children first (Restrict on subtasks/subprojects).
    await deleteTask(authed, blocked.id);
    await deleteTask(authed, blocker.id);
    await deleteNote(authed, note.id);
    await deleteProject(authed, child.id);
    await deleteProject(authed, parent.id);
    expect(await db.task.findUnique({ where: { id: blocker.id } })).toBeNull();

    // Import — one transaction, ids preserved.
    const summary = await importWorkspace(authed, doc);
    expect(summary).toEqual({ projects: 2, tasks: 2, notes: 1, edges: 1 });

    const restoredChild = await db.project.findUniqueOrThrow({ where: { id: child.id } });
    expect(restoredChild).toMatchObject({
      slug: child.slug,
      name: child.name,
      status: "REQUESTED",
      leadId: user.id,
      parentProjectId: parent.id,
    });
    expect(restoredChild.dueAt?.toISOString()).toBe(childDueAt.toISOString());

    const restoredBlocked = await db.task.findUniqueOrThrow({
      where: { id: blocked.id },
      include: { blockedBy: true },
    });
    expect(restoredBlocked).toMatchObject({
      title: blocked.title,
      status: "BACKLOG",
      parentTaskId: blocker.id,
      projectId: child.id,
    });
    expect(restoredBlocked.blockedBy.map((e) => e.blockingTaskId)).toEqual([blocker.id]);

    const restoredBlocker = await db.task.findUniqueOrThrow({
      where: { id: blocker.id },
      include: { assignees: true },
    });
    expect(restoredBlocker.labels).toEqual(["round", "trip"]);
    expect(restoredBlocker.assignees).toMatchObject([{ userId: user.id, estimateMinutes: 45 }]);
    expect(restoredBlocker.startAt?.toISOString()).toBe(blockerStartAt.toISOString());
    expect(restoredBlocker.dueAt?.toISOString()).toBe(blockerDueAt.toISOString());

    const restoredNote = await db.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(restoredNote).toMatchObject({ title: note.title, pinned: true, projectId: parent.id });
    expect(restoredNote.locationId).toBe(location.id);

    // Re-import is idempotent: upserts + edge skip, no crash.
    const again = await importWorkspace(authed, doc);
    expect(again).toEqual({ projects: 2, tasks: 2, notes: 1, edges: 0 });
  });

  it("refuses a dependency cycle all-or-nothing", async () => {
    const before = await db.task.count();
    const doc = {
      format: "jiangtang-workspace",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [],
      notes: [],
      tasks: [
        { id: cid("cyca"), title: `${RUN} cyc-a`, status: "BACKLOG", blockedBy: [cid("cycb")] },
        { id: cid("cycb"), title: `${RUN} cyc-b`, status: "BACKLOG", blockedBy: [cid("cyca")] },
      ],
    };
    await expect(importWorkspace(actor, doc)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.task.count()).toBe(before);
  });

  it("refuses an unknown assignee email and writes nothing", async () => {
    const before = await db.task.count();
    const doc = {
      format: "jiangtang-workspace",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [],
      notes: [],
      tasks: [
        {
          id: cid("unk"),
          title: `${RUN} unknown-assignee`,
          status: "BACKLOG",
          assignees: [{ email: `${RUN}-ghost@test.local`, estimateMinutes: null }],
        },
      ],
    };
    await expect(importWorkspace(actor, doc)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.task.count()).toBe(before);
  });

  it("refuses a non-cuid id at schema level", async () => {
    const doc = {
      format: "jiangtang-workspace",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [],
      notes: [],
      tasks: [{ id: "not-a-cuid", title: "x", status: "BACKLOG" }],
    };
    await expect(importWorkspace(actor, doc)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a wrong format/version", async () => {
    await expect(
      importWorkspace(actor, {
        format: "jiangtang-workspace",
        version: 2,
        tasks: [],
        projects: [],
        notes: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      importWorkspace(actor, {
        format: "unrecognized-workspace",
        version: 1,
        tasks: [],
        projects: [],
        notes: [],
      }),
    ).rejects.toMatchObject({
      formErrors: expect.arrayContaining([
        "Die Datei ist kein gültiger jiangtang-workspace-Export.",
      ]),
    });
  });
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TARGET_DB = "jiangtang_transfer_test";

describe("transfer schema: reserved demo ids", () => {
  const empty = { format: "jiangtang-workspace", version: 1, projects: [], tasks: [], notes: [] };

  it("accepts CUIDs and representative seed ids in every transfer-only position", () => {
    const doc = {
      ...empty,
      projects: [
        {
          id: "seed_proj_logistik",
          slug: "demo-logistik",
          name: "Demo",
          status: "CONFIRMED",
        },
      ],
      tasks: [
        {
          id: "seed_task_hs_09",
          title: "Seed child",
          status: "TODO",
          parentTaskId: "seed_task_hs_04",
          blockedBy: ["seed_task_hs_05"],
        },
        {
          id: cid("cuidrow"),
          title: "Cuid child",
          status: "TODO",
          parentTaskId: "seed_task_hs_09",
          blockedBy: ["seed_task_hs_04"],
        },
      ],
      notes: [
        {
          id: "seed_note_01",
          title: "Seed note",
          locationId: "seed_loc_site_campus",
        },
      ],
    };
    const result = workspaceTransferSchema.safeParse(doc);
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
  });

  it.each([
    ["task-1", "task-1"],
    ["a UUID", "123e4567-e89b-12d3-a456-426614174000"],
    ["a bare seed prefix", "seed_"],
    ["a path", "seed_../x"],
    ["a hyphenated segment", "seed_a-b"],
    ["an uppercase demo prefix", "Seed_project"],
    ["an empty segment", "seed_a__b"],
    ["an overlength id", `seed_${"a".repeat(60)}`],
  ])("still rejects %s", (_label, value) => {
    const doc = { ...empty, tasks: [{ id: value, title: "x", status: "TODO" }] };
    expect(workspaceTransferSchema.safeParse(doc).success).toBe(false);
  });

  it("applies the transfer-only union to references, not only row ids", () => {
    const badParent = {
      ...empty,
      tasks: [{ id: "seed_task_hs_09", title: "x", status: "TODO", parentTaskId: "task-1" }],
    };
    const badBlocker = {
      ...empty,
      tasks: [{ id: "seed_task_hs_09", title: "x", status: "TODO", blockedBy: ["seed_"] }],
    };
    const badLocation = {
      ...empty,
      notes: [{ id: "seed_note_01", title: "x", locationId: "seed_../x" }],
    };
    expect(workspaceTransferSchema.safeParse(badParent).success).toBe(false);
    expect(workspaceTransferSchema.safeParse(badBlocker).success).toBe(false);
    expect(workspaceTransferSchema.safeParse(badLocation).success).toBe(false);
  });
});

describe("transfer: seeded workspace raw export", () => {
  const mixed: {
    actor?: AuditActor;
    userId?: string;
    projectId?: string;
    taskId?: string;
    noteId?: string;
  } = {};

  beforeAll(async () => {
    // A user-created slice makes the export genuinely mixed (demo + user rows).
    const user = await db.user.create({
      data: { email: `${RUN}-mix@test.local`, name: `${RUN} Mix`, initials: "XM" },
    });
    mixed.userId = user.id;
    userIds.push(user.id);
    const authed: AuditActor = { id: user.id, name: user.name, initials: user.initials };
    mixed.actor = authed;

    const project = await createProject(authed, {
      name: `${RUN} Mixed`,
      description: "M",
      status: "CONFIRMED",
      color: "#654321",
      startAt: undefined,
      dueAt: new Date("2026-12-01T10:00:00Z"),
      leadId: user.id,
      parentProjectId: undefined,
    });
    mixed.projectId = project.id;
    projectIds.push(project.id);

    const seedTask = await db.task.findFirstOrThrow({
      where: { id: { startsWith: "seed_task_" } },
      select: { id: true },
    });
    const task = await createTask(
      authed,
      {
        title: `${RUN} mixed task`,
        status: "IN_PROGRESS",
        estimateMinutes: 120,
        projectId: project.id,
        labels: ["mixed"],
        body: "M",
        priority: "HIGH",
        startAt: new Date("2026-11-01T09:00:00Z"),
        dueAt: new Date("2026-11-15T17:00:00Z"),
        parentTaskId: undefined,
        locationId: undefined,
      },
      [{ userId: user.id, estimateMinutes: 60 }],
    );
    mixed.taskId = task.id;
    taskIds.push(task.id);
    await addTaskBlocker(authed, task.id, seedTask.id);

    const location = await db.location.findFirstOrThrow({
      where: { id: { startsWith: "seed_loc_" } },
      select: { id: true },
    });
    const note = await createNote(authed, {
      title: `${RUN} mixed note`,
      body: "mix",
      tags: ["mixed"],
      pinned: false,
      projectId: project.id,
      locationId: location.id,
    });
    mixed.noteId = note.id;
    noteIds.push(note.id);
  });

  it("accepts the unfiltered JSON-round-tripped pointer export from the seeded DB", async () => {
    const raw = JSON.parse(JSON.stringify(await exportWorkspace()));
    expect(raw.projects.some((p: { id: string }) => p.id.startsWith("seed_"))).toBe(true);
    expect(raw.tasks.some((t: { id: string }) => t.id.startsWith("seed_"))).toBe(true);
    expect(raw.notes.some((n: { id: string }) => n.id.startsWith("seed_"))).toBe(true);
    const result = workspaceTransferSchema.safeParse(raw);
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues.slice(0, 5)),
    ).toBe(true);
  });

  it("re-imports the unfiltered mixed raw export and keeps every reference", async () => {
    const raw = JSON.parse(JSON.stringify(await exportWorkspace()));
    const doc = workspaceTransferSchema.parse(raw);
    const beforeDependencies = await db.taskDependency.count();
    const summary = await importWorkspace(mixed.actor!, raw);
    const rawEdges = doc.tasks.reduce((sum, t) => sum + t.blockedBy.length, 0);

    expect(summary.projects).toBe(doc.projects.length);
    expect(summary.tasks).toBe(doc.tasks.length);
    expect(summary.notes).toBe(doc.notes.length);
    // Every raw edge whose endpoints are in the file is created or already present.
    expect(summary.edges + beforeDependencies).toBeGreaterThanOrEqual(rawEdges);

    const projectIdsAfter = new Set(
      (await db.project.findMany({ select: { id: true } })).map((p) => p.id),
    );
    const taskIdsAfter = new Set(
      (await db.task.findMany({ select: { id: true } })).map((t) => t.id),
    );
    const noteIdsAfter = new Set(
      (await db.note.findMany({ select: { id: true } })).map((n) => n.id),
    );
    for (const p of doc.projects) expect(projectIdsAfter.has(p.id), p.id).toBe(true);
    for (const t of doc.tasks) expect(taskIdsAfter.has(t.id), t.id).toBe(true);
    for (const n of doc.notes) expect(noteIdsAfter.has(n.id), n.id).toBe(true);

    const rawChild = doc.tasks.find((t) => t.parentTaskId !== null);
    expect(rawChild).toBeDefined();
    const child = await db.task.findUniqueOrThrow({ where: { id: rawChild!.id } });
    expect(child.parentTaskId).toBe(rawChild!.parentTaskId);

    const rawBlocked = doc.tasks.find((t) => t.blockedBy.length > 0);
    expect(rawBlocked).toBeDefined();
    const blocked = await db.task.findUniqueOrThrow({
      where: { id: rawBlocked!.id },
      include: { blockedBy: true },
    });
    expect(blocked.blockedBy.map((e) => e.blockingTaskId).sort()).toEqual(
      [...rawBlocked!.blockedBy].sort(),
    );

    const rawAssigned = doc.tasks.find((t) => t.assignees.length > 0);
    expect(rawAssigned).toBeDefined();
    const assigned = await db.task.findUniqueOrThrow({
      where: { id: rawAssigned!.id },
      include: { assignees: { include: { user: true } } },
    });
    expect(
      assigned.assignees
        .map((a) => ({ email: a.user.email, estimateMinutes: a.estimateMinutes }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    ).toEqual([...rawAssigned!.assignees].sort((a, b) => a.email.localeCompare(b.email)));

    const rawNote = doc.notes.find((n) => n.locationId !== null);
    expect(rawNote).toBeDefined();
    const note = await db.note.findUniqueOrThrow({ where: { id: rawNote!.id } });
    expect(note.locationId).toBe(rawNote!.locationId);

    const rawProject = doc.projects.find((p) => p.dueAt !== null);
    expect(rawProject).toBeDefined();
    const project = await db.project.findUniqueOrThrow({ where: { id: rawProject!.id } });
    expect(project.dueAt?.toISOString()).toBe(rawProject!.dueAt!.toISOString());

    // Task dates too.
    const rawTaskWithDates = doc.tasks.find((t) => t.startAt !== null || t.dueAt !== null);
    expect(rawTaskWithDates).toBeDefined();
    const datedTask = await db.task.findUniqueOrThrow({ where: { id: rawTaskWithDates!.id } });
    expect(datedTask.startAt?.toISOString() ?? null).toBe(
      rawTaskWithDates!.startAt?.toISOString() ?? null,
    );
    expect(datedTask.dueAt?.toISOString() ?? null).toBe(
      rawTaskWithDates!.dueAt?.toISOString() ?? null,
    );

    // Mixed rows keep their CUIDs and relationships.
    expect(taskIdsAfter.has(mixed.taskId!)).toBe(true);
    expect(noteIdsAfter.has(mixed.noteId!)).toBe(true);
    expect(projectIdsAfter.has(mixed.projectId!)).toBe(true);
  });
});

describe("transfer: reserved ids into a disposable target", () => {
  it("inserts the complete mixed export into a users+locations-only target", async () => {
    const raw = JSON.parse(JSON.stringify(await exportWorkspace()));
    const targetUrl = (() => {
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${TARGET_DB}`;
      return url.toString();
    })();
    const adminUrl = (() => {
      const url = new URL(targetUrl);
      url.pathname = "/postgres";
      return url.toString();
    })();

    const dropTarget = async () => {
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${TARGET_DB}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    };

    await dropTarget();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${TARGET_DB}"`);
    } finally {
      await admin.end();
    }
    execFileSync("pnpm", ["db:deploy"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: targetUrl },
      stdio: "pipe",
      shell: true,
    });

    const adapter = new PrismaPg({
      connectionString: targetUrl,
      options: "-c TimeZone=UTC",
    });
    const target = new PrismaClient({ adapter });
    const scratch = mkdtempSync(join(tmpdir(), "b09-import-"));
    try {
      const users = await db.user.findMany();
      const locations = await db.location.findMany();
      await target.user.createMany({
        data: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          initials: u.initials,
          role: u.role,
          isActive: u.isActive,
          emailVerified: u.emailVerified,
          image: u.image,
          weeklyCapacityMinutes: u.weeklyCapacityMinutes,
        })),
      });
      await target.location.createMany({
        data: locations.map((l) => ({
          id: l.id,
          name: l.name,
          code: l.code,
          kind: l.kind,
          address: l.address,
          description: l.description,
          parentId: null,
          createdById: null,
        })),
      });
      for (const l of locations) {
        if (l.parentId) {
          await target.location.update({
            where: { id: l.id },
            data: { parentId: l.parentId },
          });
        }
      }
      // No Accounts/passwords are copied; the import actor is a separate
      // synthetic admin created normally in this disposable target.
      const importer = await target.user.create({
        data: {
          email: `${RUN}-b09-admin@test.local`,
          name: "Transfer Importer",
          initials: "B9",
          role: "ADMIN",
          emailVerified: true,
        },
      });

      const fixturePath = join(scratch, "export.json");
      const childPath = join(scratch, "import.mjs");
      writeFileSync(fixturePath, JSON.stringify(raw));
      writeFileSync(
        childPath,
        `import { readFileSync } from "node:fs";
const { importWorkspace } = await import(process.env.IMPORT_MODULE_URL);
const raw = JSON.parse(readFileSync(process.env.TRANSFER_FIXTURE, "utf8"));
const summary = await importWorkspace(
  { id: process.env.IMPORT_ACTOR_ID, name: "Transfer Importer", initials: "TR" },
  raw,
);
console.log("IMPORT_SUMMARY=" + JSON.stringify(summary));
`,
      );
      const result = spawnSync("pnpm", ["exec", "tsx", childPath], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: targetUrl,
          IMPORT_MODULE_URL: pathToFileURL(
            join(REPO_ROOT, "app/domains/transfer/transfer.server.ts"),
          ).href,
          TRANSFER_FIXTURE: fixturePath,
          IMPORT_ACTOR_ID: importer.id,
        },
        encoding: "utf8",
        timeout: 120_000,
        shell: true,
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const summaryLine = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("IMPORT_SUMMARY="));
      expect(summaryLine, result.stdout).toBeDefined();
      const summary = JSON.parse(summaryLine!.slice("IMPORT_SUMMARY=".length));
      expect(summary).toEqual({
        projects: raw.projects.length,
        tasks: raw.tasks.length,
        notes: raw.notes.length,
        edges: raw.tasks.reduce(
          (sum: number, t: { blockedBy: string[] }) => sum + t.blockedBy.length,
          0,
        ),
      });

      expect(await target.project.count()).toBe(raw.projects.length);
      expect(await target.task.count()).toBe(raw.tasks.length);
      expect(await target.note.count()).toBe(raw.notes.length);
      expect(await target.account.count()).toBe(0);
      expect(await target.user.count()).toBe(users.length + 1);
      expect(await target.location.count()).toBe(locations.length);

      // EVERY exported edge, parent, assignee share, location and date — not a
      // single sample per field.
      const sortAssignees = (rows: { email: string; estimateMinutes: number | null }[]) =>
        [...rows].sort((a, b) => a.email.localeCompare(b.email));
      const rawProjectIdBySlug = new Map(
        raw.projects.map((p: { slug: string; id: string }) => [p.slug, p.id]),
      );
      const targetTasks = await target.task.findMany({
        include: { blockedBy: true, assignees: { include: { user: true } } },
      });
      const targetTaskById = new Map(targetTasks.map((t) => [t.id, t]));
      for (const t of raw.tasks) {
        const stored = targetTaskById.get(t.id);
        expect(stored, t.id).toBeDefined();
        expect(stored!.parentTaskId, t.id).toBe(t.parentTaskId);
        expect(stored!.projectId ?? null, t.id).toBe(
          t.projectSlug ? (rawProjectIdBySlug.get(t.projectSlug) ?? null) : null,
        );
        expect(stored!.startAt?.toISOString() ?? null, t.id).toBe(t.startAt);
        expect(stored!.dueAt?.toISOString() ?? null, t.id).toBe(t.dueAt);
        expect(stored!.blockedBy.map((e) => e.blockingTaskId).sort(), t.id).toEqual(
          [...t.blockedBy].sort(),
        );
        expect(
          sortAssignees(
            stored!.assignees.map((a) => ({
              email: a.user.email,
              estimateMinutes: a.estimateMinutes,
            })),
          ),
          t.id,
        ).toEqual(sortAssignees(t.assignees));
      }

      const targetNoteById = new Map((await target.note.findMany()).map((n) => [n.id, n]));
      for (const n of raw.notes) {
        const stored = targetNoteById.get(n.id);
        expect(stored, n.id).toBeDefined();
        expect(stored!.locationId ?? null, n.id).toBe(n.locationId);
        expect(stored!.projectId ?? null, n.id).toBe(
          n.projectSlug ? (rawProjectIdBySlug.get(n.projectSlug) ?? null) : null,
        );
      }

      const targetProjectById = new Map((await target.project.findMany()).map((p) => [p.id, p]));
      for (const p of raw.projects) {
        const stored = targetProjectById.get(p.id);
        expect(stored, p.id).toBeDefined();
        expect(stored!.startAt?.toISOString() ?? null, p.id).toBe(p.startAt);
        expect(stored!.dueAt?.toISOString() ?? null, p.id).toBe(p.dueAt);
        expect(stored!.parentProjectId ?? null, p.id).toBe(
          p.parentSlug ? (rawProjectIdBySlug.get(p.parentSlug) ?? null) : null,
        );
      }
    } finally {
      await target.$disconnect();
      rmSync(scratch, { recursive: true, force: true });
      await dropTarget();
    }
  }, 180_000);
});
