import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The `workitem` board exists, and it is a `UNION ALL` view over Task and
 * Ticket with one lane vocabulary for two lifecycles.
 *
 * Prisma Migrate ignores views in BOTH directions (`migrate diff` emits
 * no `CREATE VIEW`, and from a database that has the view, no `DROP VIEW`
 * either), so this object cannot be generated, cannot be introspected by
 * `db:generate`, and — the half that matters — a slice can pass every gate and
 * still ship no view. Two of these tests therefore read the committed migration
 * text off disk instead of trusting the database: the database can have the
 * view because somebody applied it by hand, which is not the same as the
 * history being able to reproduce it.
 *
 * Three things keep these from being rot-checks that only ever report green:
 *
 *  1. **Comment-stripped before scanning.** The migration's own header *names*
 *     `CREATE VIEW` and `DROP VIEW` while explaining that Prisma emits neither,
 *     so a raw substring test would pass on the comment alone. `guards.sh` made
 *     the same call for its `during` check; the same reasoning applies here.
 *  2. **An in-file negative control** for the scanner, so the predicate is
 *     shown to be able to fail rather than assumed to be.
 *  3. **Structural assertions, not absolute ones, where the corpus allows it.**
 *     The row count is asserted as `view = Task + Ticket`, which holds on an
 *     empty CI database and on a seeded dev one; the seeded counts (40/12/52)
 *     are asserted *only when the seed is actually present*, detected by query
 *     rather than assumed. That keeps the guard from
 *     inheriting a baseline.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");

/** The canonical baseline directory that owns the view. The property asserted
 *  below is the one that matters — exactly ONE migration in the committed chain
 *  creates it — and it is asserted over every directory on disk, not by name:
 *  a chain split into two creators, or a view that survived only in a comment
 *  elsewhere, is red. The name is then pinned so a rename or a re-split lands in
 *  the diff instead of being silently absorbed. */
const WORKITEM_VIEW_MIGRATION = "20261023000500_workitem_view";

function findWorkitemMigration(): string {
  const creators = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(MIGRATIONS_DIR, d.name, "migration.sql"))
    .filter((file) =>
      /CREATE\s+VIEW\s+"workitem"/i.test(stripSqlComments(readFileSync(file, "utf8"))),
    );
  expect(creators, 'exactly one committed migration must create the "workitem" view').toHaveLength(
    1,
  );
  const found = creators[0] as string;
  expect(basename(dirname(found)), "the view is owned by the canonical baseline directory").toBe(
    WORKITEM_VIEW_MIGRATION,
  );
  return found;
}

/** Executable SQL only: `/* … *\/` blocks and `-- …` to end of line removed, so
 *  prose that NAMES a statement cannot satisfy a scan for it. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

/** Run fn in a transaction that is ALWAYS rolled back (per-test isolation). */
async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

let seq = 0;
const uid = (p: string) => `b4_${p}_${Date.now()}_${seq++}`;

async function insertTask(
  c: PoolClient,
  over: { id: string; title?: string; status?: string; priority?: string | null },
): Promise<string> {
  await c.query(
    `INSERT INTO "Task"(id,title,status,priority,"updatedAt") VALUES($1,$2,$3::"TaskStatus",$4::"TaskPriority",now())`,
    [over.id, over.title ?? "b4 task", over.status ?? "TODO", over.priority ?? null],
  );
  return over.id;
}

async function insertTicket(
  c: PoolClient,
  over: { id: string; title?: string; status?: string; priority?: number | null },
): Promise<string> {
  await c.query(
    `INSERT INTO "Ticket"(id,type,status,title,priority,"updatedAt") VALUES($1,'INCIDENT',$2::"TicketStatus",$3,$4,now())`,
    [over.id, over.status ?? "OPEN", over.title ?? "b4 ticket", over.priority ?? null],
  );
  return over.id;
}

async function insertUser(c: PoolClient, id: string): Promise<string> {
  await c.query(`INSERT INTO "User"(id,email,name,"updatedAt") VALUES($1,$2,$3,now())`, [
    id,
    `${id}@workitem.invalid`,
    "Workitem Tester",
  ]);
  return id;
}

describe("workitem view (the committed history reaches the full schema)", () => {
  it("(1) every committed migration is applied here, and the DB invariants are intact", async () => {
    const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    const { rows } = await pool.query<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`);
    const applied = rows
      .filter((r) => r.finished_at !== null && r.rolled_back_at === null)
      .map((r) => r.migration_name)
      .sort();

    // Not ">=" and not "contains": the criterion is that the committed history
    // ALONE reaches the full schema, so an unapplied migration is a failure.
    expect(applied).toEqual(onDisk);

    const { rows: excl } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('event_room_no_overlap','equipment_alloc_no_overlap') ORDER BY conname`,
    );
    expect(excl.map((r) => r.conname)).toEqual([
      "equipment_alloc_no_overlap",
      "event_room_no_overlap",
    ]);

    const { rows: trg } = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'activitylog_no_update_delete'`,
    );
    expect(trg.map((r) => r.tgname)).toEqual(["activitylog_no_update_delete"]);

    // The third invariant — the EXIF/GPS strip — is not a database object; it is
    // asserted by its own test in the same suite, and both were measured against
    // a clean room built from this history alone.
  });
});

describe("workitem view (the view exists, answers, and comes from the migration)", () => {
  it("(2) the view exists, answers, and this migration's text creates it", async () => {
    const { rows } = await pool.query<{ viewname: string }>(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'workitem'`,
    );
    expect(rows.map((r) => r.viewname)).toEqual(["workitem"]);

    // "answers": the view is queryable, not merely present in the catalog.
    const { rows: answer } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workitem`,
    );
    expect(Number(answer[0]?.n)).toBeGreaterThanOrEqual(0);

    // "created by this migration" — the half the database cannot prove. A view
    // that exists on dev because somebody ran the SQL by hand is still missing
    // from the history, and a fresh `db:deploy` would not produce it.
    const sql = stripSqlComments(readFileSync(findWorkitemMigration(), "utf8"));
    expect(sql).toMatch(/CREATE\s+VIEW\s+"workitem"/i);
    expect(sql).toMatch(/CREATE\s+TABLE\s+"workitem_lane"/i);
    expect(sql).not.toMatch(/DROP\s+VIEW/i);
    expect(sql).not.toMatch(/DROP\s+TABLE\s+"workitem_lane"/i);
  });

  it("(2) negative control: the same scanner reports a migration that lacks the view", () => {
    // Without this, "the scanner found CREATE VIEW" is indistinguishable from
    // "the scanner matches everything".
    const decoy = stripSqlComments(
      `-- this comment names CREATE VIEW "workitem" and must not satisfy the scan
       CREATE TABLE "something_else" (id text);`,
    );
    expect(decoy).not.toMatch(/CREATE\s+VIEW\s+"workitem"/i);
    expect(decoy).not.toMatch(/CREATE\s+TABLE\s+"workitem_lane"/i);
  });
});

describe("workitem view (the column list)", () => {
  it("(3) its columns are exactly the documented nine, in that order", async () => {
    const { rows } = await pool.query<{ ordinal_position: string; column_name: string }>(
      `SELECT ordinal_position::text, column_name
       FROM information_schema.columns WHERE table_name = 'workitem'
       ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id",
      "kind",
      "title",
      "lane",
      "sort_priority",
      "assignee_ids",
      "project_id",
      "due_at",
      "updated_at",
    ]);
    expect(rows.map((r) => Number(r.ordinal_position))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("workitem view (one row per Task and one per Ticket)", () => {
  it("(4) the view has exactly one row per base row of each family, and never duplicates one", async () => {
    const { rows } = await pool.query<{
      view_rows: string;
      expected: string;
      tasks: string;
      tickets: string;
      distinct_ids: string;
    }>(
      `SELECT (SELECT count(*) FROM workitem)::text AS view_rows,
              ((SELECT count(*) FROM "Task") + (SELECT count(*) FROM "Ticket"))::text AS expected,
              (SELECT count(*) FROM workitem WHERE kind = 'TASK')::text AS tasks,
              (SELECT count(*) FROM workitem WHERE kind = 'TICKET')::text AS tickets,
              (SELECT count(DISTINCT id) FROM workitem)::text AS distinct_ids`,
    );
    const r = rows[0];
    expect(Number(r?.view_rows)).toBe(Number(r?.expected));
    expect(Number(r?.tasks) + Number(r?.tickets)).toBe(Number(r?.expected));
    // A status mapped to two lanes would multiply rows through the join, so the
    // id count is what turns that into a failure rather than a longer board.
    expect(Number(r?.distinct_ids)).toBe(Number(r?.expected));
  });

  it("(4) on the seeded corpus the counts are exact: 41 tasks, 12 tickets, 53 rows", async () => {
    // Detected by query, never assumed — an unseeded database (CI's service, a
    // fresh dev volume) legitimately holds 0 and must not go red here. On a
    // seeded one these are the seed counts, and a tilde could not fail.
    const { rows: seed } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Task" WHERE starts_with(id, 'seed_')`,
    );
    if (Number(seed[0]?.n) === 0) return;

    const { rows } = await pool.query<{ tasks: string; tickets: string; view_rows: string }>(
      `SELECT (SELECT count(*) FROM "Task")::text AS tasks,
              (SELECT count(*) FROM "Ticket")::text AS tickets,
              (SELECT count(*) FROM workitem)::text AS view_rows`,
    );
    expect(Number(rows[0]?.tasks)).toBe(41);
    expect(Number(rows[0]?.tickets)).toBe(12);
    expect(Number(rows[0]?.view_rows)).toBe(53);
  });
});

describe("workitem view (the coverage guarantee)", () => {
  it("(5) no row's lane is NULL", async () => {
    const { rows } = await pool.query<{ nulls: string; total: string }>(
      `SELECT count(*) FILTER (WHERE lane IS NULL)::text AS nulls, count(*)::text AS total FROM workitem`,
    );
    // 0 === 0 on an empty database, so the coverage half of this criterion is
    // asserted separately below — that is the half that fires when someone adds
    // an enum value and forgets the mapping row.
    expect(Number(rows[0]?.nulls)).toBe(0);
  });

  it("(5) every live status value of BOTH enums maps to exactly one lane", async () => {
    // Read from pg_enum, not from a hand-copied list: the failure this exists to
    // catch is a NEW enum value, and a hand-copied list would not see it.
    const { rows: enums } = await pool.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname IN ('TaskStatus','TicketStatus')`,
    );
    const { rows: lanes } = await pool.query<{
      lane: string;
      task_statuses: string[];
      ticket_statuses: string[];
    }>(`SELECT lane, task_statuses, ticket_statuses FROM "workitem_lane" ORDER BY lane`);

    for (const [typname, column] of [
      ["TaskStatus", "task_statuses"],
      ["TicketStatus", "ticket_statuses"],
    ] as const) {
      const live = enums
        .filter((e) => e.typname === typname)
        .map((e) => e.enumlabel)
        .sort();
      const mapped = lanes.flatMap((l) => l[column]);
      // Exactly once each: zero is the NULL-lane bug, two is the duplicate-row
      // bug, and an unrecognised value is the typo bug. All three are red.
      expect([...mapped].sort()).toEqual(live);
    }
  });
});

describe("workitem view (sort_priority is projected, not promised)", () => {
  it("(6) a prioritised row carries its value, an unprioritised one is NULL, and NULLS LAST is the consumer's job", async () => {
    await inRolledBackTx(async (c) => {
      const pTask = await insertTask(c, {
        id: uid("task_p"),
        status: "IN_PROGRESS",
        priority: "URGENT",
      });
      const nTask = await insertTask(c, { id: uid("task_n"), status: "TODO", priority: null });
      const pTicket = await insertTicket(c, { id: uid("tick_p"), status: "OPEN", priority: 2 });
      const nTicket = await insertTicket(c, { id: uid("tick_n"), status: "OPEN", priority: null });

      const { rows } = await c.query<{
        id: string;
        kind: string;
        sort_priority: number | null;
        lane: string;
      }>(`SELECT id, kind, sort_priority, lane FROM workitem WHERE id = ANY($1::text[])`, [
        [pTask, nTask, pTicket, nTicket],
      ]);
      const by = new Map(rows.map((r) => [r.id, r]));

      // The TaskPriority enum has no integers of its own and is mapped onto the
      // ticket scale, 1 being the most urgent.
      expect(by.get(pTask)?.sort_priority).toBe(1);
      expect(by.get(nTask)?.sort_priority).toBeNull();
      expect(by.get(pTicket)?.sort_priority).toBe(2);
      expect(by.get(nTicket)?.sort_priority).toBeNull();

      // the view PROJECTS the column; the ordering is a property of the
      // statement that reads it. So the ordering is asserted on the query, and
      // the view itself carries no ORDER BY to lean on.
      const { rows: ordered } = await c.query<{ id: string }>(
        `SELECT id FROM workitem WHERE id = ANY($1::text[])
         ORDER BY sort_priority ASC NULLS LAST`,
        [[pTask, nTask, pTicket, nTicket]],
      );
      expect(
        ordered
          .slice(0, 2)
          .map((r) => r.id)
          .sort(),
      ).toEqual([pTask, pTicket].sort());
      expect(
        ordered
          .slice(2)
          .map((r) => r.id)
          .sort(),
      ).toEqual([nTask, nTicket].sort());
    });
  });
});

describe("workitem view (both link FKs are SetNull)", () => {
  it("(7) Ticket.taskId and Task.ticketId both exist with confdeltype 'n'", async () => {
    // Reciprocity between the two links is a property of the write path, but
    // "neither link can destroy the other" IS expressible, and it is asserted
    // the way booking-constraints.test.ts:93
    // asserts an EXCLUDE — read from pg_constraint, so a DROPPED or CHANGED FK
    // fires rather than only a failing delete.
    //
    // Negative control, not encoded here: changing one FK's action to RESTRICT
    // turns exactly this test red; restored byte-identical afterwards.
    const { rows } = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conname IN ('Ticket_taskId_fkey','Task_ticketId_fkey') ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: "Task_ticketId_fkey", confdeltype: "n" },
      { conname: "Ticket_taskId_fkey", confdeltype: "n" },
    ]);
  });
});

describe("workitem view (the lane table ships its rows)", () => {
  it("(8) workitem_lane holds exactly the documented five lanes and nothing else", async () => {
    const { rows } = await pool.query<{
      lane: string;
      task_statuses: string[];
      ticket_statuses: string[];
    }>(`SELECT lane, task_statuses, ticket_statuses FROM "workitem_lane" ORDER BY lane`);

    // A mapping table with no rows answers NULL for every status, which is
    // precisely criterion (5)'s failure — so the rows are asserted, not assumed.
    expect(rows.map((r) => [r.lane, r.task_statuses, r.ticket_statuses])).toEqual([
      ["BACKLOG", ["BACKLOG", "TODO"], ["OPEN"]],
      ["CANCELLED", ["CANCELLED"], ["CANCELLED"]],
      ["DONE", ["DONE"], ["RESOLVED"]],
      ["IN_PROGRESS", ["IN_PROGRESS"], ["IN_PROGRESS"]],
      ["IN_REVIEW", ["IN_REVIEW", "BLOCKED"], []],
    ]);
  });
});

describe("workitem view (beyond the numbered criteria — the arms' own data survives the union)", () => {
  it("(extra) assignee_ids is projected from BOTH arms' m-n joins, empty rather than NULL when unassigned", async () => {
    // Not a numbered criterion, and deliberately so: the seeded corpus assigns
    // NOBODY (measured 10:0x — 0 of 52 rows carry an assignee), so without this
    // the two LATERAL joins would be unexercised on every machine that runs the
    // suite, and a view that answered `{}` for everybody would stay green.
    await inRolledBackTx(async (c) => {
      const user = await insertUser(c, uid("user"));
      const withOne = await insertTask(c, { id: uid("task_a"), status: "DONE", priority: "LOW" });
      const withNone = await insertTask(c, { id: uid("task_b"), status: "DONE" });
      const tickOne = await insertTicket(c, { id: uid("tick_a"), status: "RESOLVED", priority: 1 });
      const tickNone = await insertTicket(c, { id: uid("tick_b"), status: "RESOLVED" });

      await c.query(`INSERT INTO "TaskAssignees"("taskId","userId") VALUES($1,$2)`, [
        withOne,
        user,
      ]);
      // Ticket.assignees is Prisma's IMPLICIT m-n: table "_Assignees", columns
      // A (Ticket) and B (User) — measured on the database, not assumed.
      // Quoted: the columns are literally "A" and "B", and an unquoted
      // identifier folds to lower case and does not exist.
      await c.query(`INSERT INTO "_Assignees"("A","B") VALUES($1,$2)`, [tickOne, user]);

      const { rows } = await c.query<{ id: string; assignee_ids: string[]; lane: string }>(
        `SELECT id, assignee_ids, lane FROM workitem WHERE id = ANY($1::text[])`,
        [[withOne, withNone, tickOne, tickNone]],
      );
      const by = new Map(rows.map((r) => [r.id, r]));

      expect(by.get(withOne)?.assignee_ids).toEqual([user]);
      expect(by.get(tickOne)?.assignee_ids).toEqual([user]);
      expect(by.get(withNone)?.assignee_ids).toEqual([]);
      expect(by.get(tickNone)?.assignee_ids).toEqual([]);
      // Same query, and the lane the mapping table resolves: DONE <- DONE, and
      // RESOLVED <- DONE. Two spellings, one vocabulary (consequence 1).
      expect(by.get(withOne)?.lane).toBe("DONE");
      expect(by.get(tickOne)?.lane).toBe("DONE");
    });
  });
});
