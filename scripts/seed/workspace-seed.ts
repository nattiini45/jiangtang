/**
 * The demo workspace seed.
 *
 * WHY THIS IS A FUNCTION AND NOT A SCRIPT: the write happens through
 * `txWithAudit` rather than a loose `insertMany`. `seedWorkspace(tx, audit)`
 * takes a caller-supplied client; the two call sites are the `prisma/seed.ts`
 * entry point and `app/lib/demo-seed.server.ts` (the dashboard's admin-only
 * „Demo-Workspace laden" — which additionally passes `assignToUserId`, see the
 * signature below). Two consequences, both requirements rather than preferences:
 *
 *   - `test/seed-integrity.test.ts` hands it a transaction it then ROLLS BACK,
 *     so the suite leaves the database exactly as it found it and CI needs no
 *     new step;
 *   - **audit rows are written, not bypassed.** A bulk writer is exactly where
 *     the audit spine is most likely to be quietly skipped, and the golden rule
 *     is that the log row commits in the SAME transaction as the mutation.
 *
 * WHY IT IS SAFE TO RUN TWICE: every row carries an explicit stable id
 * and a row is written **only when that id is absent**. Never an update, never
 * a delete: both delete-then-insert and a full-update upsert were rejected for
 * the same reason: a demo workspace exists to be played with, and a second run must
 * not wipe the edits someone made to it. Because a re-run performs no mutation,
 * it also writes no audit row, which is what keeps the append-only log a record
 * of things that actually happened rather than of runs.
 *
 * WHY IT LIVES UNDER `scripts/` AND NOT `app/`: the cross-folder-ownership
 * guard (`test/cross-folder-writes.test.ts`) deliberately pins the `app/lib`
 * User writers to exactly two files, and a model can be owned by at most one
 * folder — a seed that writes every model cannot live inside the scanned tree
 * without carving the guard open. `app/` callers reach it through
 * `app/lib/demo-seed.server.ts`, which holds no write site itself.
 */
import type { Tx } from "~/lib/db.server";
import type { AuditFn } from "~/lib/audit.server";
import type { EntityType } from "~/lib/realtime/events";
import type { Prisma } from "~/generated/prisma/client";
import {
  ADMIN_SEED_ASSIGNMENTS,
  ADMIN_SEED_TICKET_IDS,
  ALL_SEED_IDS,
  DEMO_TEAM,
  DEMO_USER,
  TASK_ASSIGNEES,
  TASK_DEPENDENCIES,
  assertCountsMatchSpec,
  atBerlinHour,
  atBerlinHourThisWeek,
  type CountKey,
} from "./data";
import { workspaceLocale } from "~/i18n/locale.server";
import type { Locale } from "~/i18n/locales";
import { seedDataFor } from "./localized";

/** The audit actor for every seeded row: the demo user, which has no credential. */
export const SEED_ACTOR = {
  id: DEMO_USER.id,
  name: DEMO_USER.name,
  email: DEMO_USER.email,
  initials: DEMO_USER.initials,
};

/**
 * Tables the seed must NOT touch: the counts of these tables are checked to be
 * unchanged by a run, and nothing else is. These are **Postgres table names as quoted SQL identifiers**, not
 * Prisma delegate names, because the guard that reads them queries them as raw
 * SQL and `SELECT count(*) FROM "equipmentModel"` resolves to nothing.
 *
 * `ActivityLog` is deliberately absent: the seed is *supposed* to add rows there.
 */
export const UNTOUCHED_TABLES = [
  "Campus",
  "Building",
  "Room",
  "EquipmentModel",
  "Equipment",
  "Event",
  "EventRoomBooking",
  "EquipmentAllocation",
  "ServiceWindow",
  "Attachment",
  "Account",
  "Session",
  "Verification",
] as const;

export type SeedSummary = {
  /** Rows actually written, per model. */
  created: Record<CountKey, number>;
  /** Rows already present and therefore left untouched, per model. */
  skipped: Record<CountKey, number>;
  /**
   * How many of the three demo `User`s this run created. Reported rather than
   * inferred: the users are not one of the counted models, and once a database has
   * been seeded they are already there, so "was it written" is a real
   * question with a real answer instead of an assumption baked into an
   * arithmetic expression.
   */
  demoUsersCreated: number;
  /**
   * Mutations performed for `assignToUserId` (the dashboard „Demo-Workspace
   * laden" path): `tasks` TaskAssignees rows created and `tickets` tickets
   * newly connected. Always {0,0} for the actor-less CLI seed.
   */
  actorLinks: { tasks: number; tickets: number };
  /**
   * Audit rows written. Equals `totalCreated` + `demoUsersCreated` +
   * `actorLinks.tickets` (the ticket connects are updates of existing rows,
   * so they are audited but not counted as created).
   */
  auditRows: number;
};

function zeroed(): Record<CountKey, number> {
  return {
    location: 0,
    project: 0,
    task: 0,
    taskDependency: 0,
    taskAssignees: 0,
    ticket: 0,
    note: 0,
    inventoryItem: 0,
    vendor: 0,
    timeEntry: 0,
  };
}

/**
 * Write one row if — and only if — its id is absent, and audit it when written.
 *
 * Returns true when the row was created. The existence probe is not
 * decoration: it is what lets a re-run write no audit row (see the header) and
 * what lets the test distinguish "the seed created it" from "it was already
 * there". Without it, the second run would report the same totals while having
 * mutated nothing.
 */
async function writeOnce(
  find: () => Promise<{ id: string } | null>,
  create: () => Promise<{ id: string }>,
  auditRow: (id: string) => Promise<void>,
): Promise<boolean> {
  if ((await find()) !== null) return false;
  const row = await create();
  await auditRow(row.id);
  return true;
}

const DEMO = { viaSeed: true } satisfies Prisma.InputJsonObject;

/**
 * The seed proper. Writes the demo workspace into `tx`, one audit row per
 * mutation, and returns what it did.
 *
 * Parent rows are written before their children on purpose: `Location.parentId`
 * and `Project.parentProjectId` are `onDelete: Restrict`, and a child inserted
 * before its parent is an FK violation rather than a reordering problem you can
 * fix later. The data arrays happen to already be in that order; the ordering
 * is stated here so a future edit does not discover it by failing.
 */
/**
 * `assignToUserId`: when the seed runs from the dashboard's
 * „Demo-Workspace laden" there is a real actor — the admin pressing the
 * button — and that admin should see demo work in „Meine Arbeit" immediately.
 * The CLI (`pnpm db:seed`) passes nothing, so no assignment rows for a real
 * user are ever written by a background run.
 */
export async function seedWorkspace(
  tx: Tx,
  audit: AuditFn,
  opts: { assignToUserId?: string; locale?: Locale } = {},
): Promise<SeedSummary> {
  assertCountsMatchSpec();
  // Wording follows the installation language; ids and structure are shared.
  const { LOCATIONS, VENDORS, PROJECTS, TASKS, TICKETS, NOTES, INVENTORY, TIME_ENTRIES } =
    seedDataFor(opts.locale ?? workspaceLocale());

  const created = zeroed();
  const skipped = zeroed();
  const actorLinks = { tasks: 0, tickets: 0 };
  let auditRows = 0;

  const record = async (key: CountKey, wrote: boolean): Promise<void> => {
    if (wrote) created[key] += 1;
    else skipped[key] += 1;
  };

  // `label` is the human-readable verb fragment and is DELIBERATELY separate
  // from `entityType`: the action names (`DemoUserSeeded` …) are existing data
  // and the vocabulary change is about the entityType column only, so re-spelling a verb nobody
  // asked about would be a second, invisible change. `entityType` is typed by
  // the one owned vocabulary, so a demo audit row can no longer invent a
  // spelling no reader can match — which is why the vocabulary had to admit
  // project/task/note/vendor as well as location/inventory-item.
  const note =
    (label: string, entityType: EntityType) =>
    async (id: string): Promise<void> => {
      auditRows += 1;
      await audit({ action: `Demo${label}Seeded`, entityType, entityId: id, data: DEMO });
    };

  // 1. The demo team (three members — Alex, Blair, Casey). Nothing below
  //    can be written without Alex: `Note.authorId` is NOT NULL, and every
  //    `createdById`/`leadId` reaches her.
  //    None of the three has an `Account` row and so none can authenticate —
  //    They are not one of the counted models, so `demoUsersCreated`
  //    reports them on their own.
  let demoUsersCreated = 0;
  for (const member of DEMO_TEAM) {
    const wrote = await writeOnce(
      () => tx.user.findUnique({ where: { id: member.id }, select: { id: true } }),
      () => tx.user.create({ data: { ...member }, select: { id: true } }),
      note("User", "user"),
    );
    if (wrote) demoUsersCreated += 1;
  }

  // 2. Locations — one per LocationKind, and a real parent/child tree.
  for (const row of LOCATIONS) {
    const wrote = await writeOnce(
      () => tx.location.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.location.create({
          data: {
            id: row.id,
            name: row.name,
            code: row.code,
            kind: row.kind,
            address: row.address,
            description: row.description,
            parentId: row.parentId,
            createdById: DEMO_USER.id,
          },
          select: { id: true },
        }),
      note("Location", "location"),
    );
    await record("location", wrote);
  }

  // 3. Vendors.
  for (const row of VENDORS) {
    const wrote = await writeOnce(
      () => tx.vendor.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.vendor.create({
          data: { ...row, createdById: DEMO_USER.id },
          select: { id: true },
        }),
      note("Vendor", "vendor"),
    );
    await record("vendor", wrote);
  }

  // 4. Projects — the first is the tree root; the rest hang off it.
  for (const row of PROJECTS) {
    const wrote = await writeOnce(
      () => tx.project.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.project.create({
          data: {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            status: row.status,
            color: row.color,
            startAt: row.startOffsetDays === null ? null : atBerlinHour(row.startOffsetDays),
            dueAt: row.dueOffsetDays === null ? null : atBerlinHour(row.dueOffsetDays, 17),
            parentProjectId: row.parentProjectId,
            leadId: DEMO_USER.id,
            createdById: DEMO_USER.id,
          },
          select: { id: true },
        }),
      note("Project", "project"),
    );
    await record("project", wrote);
  }

  // 5. Tasks. Every task here carries a projectId, so every projectId resolves.
  for (const row of TASKS) {
    const wrote = await writeOnce(
      () => tx.task.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.task.create({
          data: {
            id: row.id,
            title: row.title,
            body: row.body ?? null,
            status: row.status,
            priority: row.priority,
            startAt:
              row.startOffsetDays === undefined
                ? atBerlinHour(row.dueOffsetDays === null ? 0 : row.dueOffsetDays - 14)
                : row.startOffsetDays === null
                  ? null
                  : atBerlinHour(row.startOffsetDays),
            dueAt: row.dueOffsetDays === null ? null : atBerlinHour(row.dueOffsetDays, 16),
            estimateMinutes: row.estimateMinutes,
            position: row.position,
            labels: [...row.labels],
            projectId: row.projectId,
            parentTaskId: row.parentTaskId,
            locationId: row.locationId,
            createdById: DEMO_USER.id,
          },
          select: { id: true },
        }),
      note("Task", "task"),
    );
    await record("task", wrote);
  }

  // 5a. Task assignees — composite-keyed, so the probe is the (taskId, userId)
  //     pair and the audit row hangs on the task, the entity the edge belongs
  //     to. `estimateMinutes` is the assignee's share.
  for (const row of TASK_ASSIGNEES) {
    const wrote = await writeOnce(
      async () =>
        (await tx.taskAssignees.findUnique({
          where: { taskId_userId: { taskId: row.taskId, userId: row.userId } },
          select: { taskId: true },
        }))
          ? { id: row.taskId }
          : null,
      async () => {
        await tx.taskAssignees.create({ data: row, select: { taskId: true } });
        return { id: row.taskId };
      },
      note("TaskAssignee", "task"),
    );
    await record("taskAssignees", wrote);
  }

  // 5b. Dependencies — same composite-key shape; the edge is audited on the
  //     BLOCKED task (`blockedByTaskId`), matching the domain's audit rule.
  for (const row of TASK_DEPENDENCIES) {
    const wrote = await writeOnce(
      async () =>
        (await tx.taskDependency.findUnique({
          where: {
            blockedByTaskId_blockingTaskId: {
              blockedByTaskId: row.blockedByTaskId,
              blockingTaskId: row.blockingTaskId,
            },
          },
          select: { blockedByTaskId: true },
        }))
          ? { id: row.blockedByTaskId }
          : null,
      async () => {
        await tx.taskDependency.create({ data: row, select: { blockedByTaskId: true } });
        return { id: row.blockedByTaskId };
      },
      note("TaskDependency", "task"),
    );
    await record("taskDependency", wrote);
  }

  // 6. Tickets. `taskId` is the ticket's own work link; the
  //    back-reference on Task stays null so one edge is never written twice.
  for (const row of TICKETS) {
    const occurredAt = atBerlinHour(row.occurredOffsetDays, 10);
    const resolved = row.status === "RESOLVED" || row.status === "CANCELLED";
    const wrote = await writeOnce(
      () => tx.ticket.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.ticket.create({
          data: {
            id: row.id,
            type: row.type,
            status: row.status,
            title: row.title,
            description: row.description,
            resolution: row.resolution,
            priority: row.priority,
            taskId: row.taskId,
            reporterId: DEMO_USER.id,
            occurredAt,
            resolvedAt: resolved ? atBerlinHour(row.occurredOffsetDays + 1, 15) : null,
          },
          select: { id: true },
        }),
      note("Ticket", "ticket"),
    );
    await record("ticket", wrote);
  }

  // 7. Notes — authorId is mandatory, so this is where the user earns its place.
  for (const row of NOTES) {
    const wrote = await writeOnce(
      () => tx.note.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.note.create({
          data: {
            id: row.id,
            title: row.title,
            body: row.body,
            pinned: row.pinned,
            authorId: DEMO_USER.id,
            projectId: row.projectId,
            locationId: row.locationId,
            tags: [...row.tags],
            archivedAt: row.archived ? atBerlinHour(-120) : null,
          },
          select: { id: true },
        }),
      note("Note", "note"),
    );
    await record("note", wrote);
  }

  // 8. Stock. `equipmentId` stays null: the seed creates no Equipment, and a
  //    link to a row that does not exist is an orphan, which the seed-integrity
  //    checks reject.
  for (const row of INVENTORY) {
    const wrote = await writeOnce(
      () => tx.inventoryItem.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.inventoryItem.create({
          data: {
            id: row.id,
            name: row.name,
            sku: row.sku,
            serial: row.serial ?? null,
            quantity: row.quantity,
            unit: row.unit,
            category: row.category,
            status: row.status,
            purchasedAt:
              row.purchaseOffsetDays === null ? null : atBerlinHour(row.purchaseOffsetDays, 12),
            // Money is never a float: Decimal all the way, string in, string out.
            purchasePrice: row.priceEuro,
            warrantyExpiresAt:
              row.warrantyOffsetDays === null ? null : atBerlinHour(row.warrantyOffsetDays, 12),
            vendorId: row.vendorId,
            locationId: row.locationId,
            tags: [...row.tags],
            createdById: DEMO_USER.id,
          },
          select: { id: true },
        }),
      note("InventoryItem", "inventory-item"),
    );
    await record("inventoryItem", wrote);
  }

  // 9. Time entries — all inside the current Berlin ISO week so the
  //    timesheet and the capacity view's „gebucht" badge have data on a fresh
  //    workspace. seed_time_01/02 overlap on purpose (overlap is legal;
  //    the day/week totals dedupe it).
  for (const row of TIME_ENTRIES) {
    const wrote = await writeOnce(
      () => tx.timeEntry.findUnique({ where: { id: row.id }, select: { id: true } }),
      () =>
        tx.timeEntry.create({
          data: {
            id: row.id,
            taskId: row.taskId,
            userId: row.userId,
            startsAt: atBerlinHourThisWeek(row.weekday, row.startHour),
            endsAt: atBerlinHourThisWeek(row.weekday, row.endHour),
            comment: row.comment,
            createdById: DEMO_USER.id,
          },
          select: { id: true },
        }),
      note("TimeEntry", "timeEntry"),
    );
    await record("timeEntry", wrote);
  }

  // 10. Loading-admin links: only when a real actor asked for the demo
  //     (the dashboard button passes `assignToUserId`; `pnpm db:seed` does
  //     not). Adds the admin to five open demo tasks and two tickets so their
  //     „Meine Arbeit" card is populated on first load. Same writeOnce rule:
  //     a re-run connects nothing twice and writes no audit row.
  if (opts.assignToUserId !== undefined) {
    const actorId = opts.assignToUserId;
    for (const row of ADMIN_SEED_ASSIGNMENTS) {
      const wrote = await writeOnce(
        async () =>
          (await tx.taskAssignees.findUnique({
            where: { taskId_userId: { taskId: row.taskId, userId: actorId } },
            select: { taskId: true },
          }))
            ? { id: row.taskId }
            : null,
        async () => {
          await tx.taskAssignees.create({
            data: { taskId: row.taskId, userId: actorId, estimateMinutes: row.estimateMinutes },
            select: { taskId: true },
          });
          return { id: row.taskId };
        },
        note("TaskAssignee", "task"),
      );
      await record("taskAssignees", wrote);
      if (wrote) actorLinks.tasks += 1;
    }
    for (const ticketId of ADMIN_SEED_TICKET_IDS) {
      // Tickets carry an implicit m-n — the "row" is a connect on the ticket.
      // The probe is "is the actor already an assignee", so a second dashboard
      // load is still a no-op.
      const wrote = await writeOnce(
        async () =>
          await tx.ticket.findFirst({
            where: { id: ticketId, assignees: { some: { id: actorId } } },
            select: { id: true },
          }),
        async () =>
          await tx.ticket.update({
            where: { id: ticketId },
            data: { assignees: { connect: { id: actorId } } },
            select: { id: true },
          }),
        note("TicketAssignee", "ticket"),
      );
      if (wrote) actorLinks.tickets += 1;
    }
  }

  return { created, skipped, demoUsersCreated, actorLinks, auditRows };
}

/** Totals the CLI prints and the test compares against. */
export function totalCreated(summary: SeedSummary): number {
  return Object.values(summary.created).reduce((a, b) => a + b, 0);
}

export function totalSkipped(summary: SeedSummary): number {
  return Object.values(summary.skipped).reduce((a, b) => a + b, 0);
}

/** Every row the seed owns, demo users included. `ALL_SEED_IDS` holds the
 *  single-id models only — the two join tables are composite-keyed, so their
 *  rows count here without a fake id. 144 on a clean database. */
export const EXPECTED_SEEDED_ROW_COUNT =
  ALL_SEED_IDS.length + TASK_ASSIGNEES.length + TASK_DEPENDENCIES.length;
