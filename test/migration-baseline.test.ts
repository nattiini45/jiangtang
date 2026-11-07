import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The eight-file migration baseline is a baseline only if it is internally
 * complete: one ordered chain, no fragment directory beside it, and the counts
 * the consolidation was accepted for. This suite asserts exactly that, and it is
 * FILESYSTEM-ONLY on purpose — it opens no pool, imports no `pg`, and reads no
 * `DATABASE_URL`, so it can run on a machine where nothing has ever executed
 * this SQL. Whether PostgreSQL accepts the seven files is a different question
 * with a different oracle (`prisma migrate deploy` into a disposable database),
 * and this suite deliberately does not pretend to answer it.
 *
 * The measurement is comment-stripped, the same call `test/workitem-view.test.ts`
 * and `guards.sh` make: the migration headers quote the statements they explain,
 * so a raw substring count would measure prose. Every count below is derived from
 * the executable SQL of the eight files, never from a summary written somewhere
 * else.
 *
 * The negative controls at the bottom mutate a COPY in the system temp
 * directory and assert the same checker rejects it. Without them, "the checker
 * reports no problems" is indistinguishable from a checker that cannot report
 * one.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRISMA_DIR = join(REPO_ROOT, "prisma");

/** The eight canonical directories, in chain order. */
const CANONICAL_DIRS = [
  "20261023000000_extensions",
  "20261023000100_core_schema",
  "20261023000200_booking_constraints",
  "20261023000300_audit_privacy",
  "20261023000400_search_indexes",
  "20261023000500_workitem_view",
  "20261023000600_time_tracking_constraints",
  "20261107161719_notification_inbox",
] as const;

/** The lane vocabulary of the mapping table, in the order the INSERT lists it. */
const CANONICAL_LANES = ["BACKLOG", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"] as const;

type Counts = {
  createType: number;
  createTable: number;
  foreignKey: number;
  createIndex: number;
  uniqueIndex: number;
  check: number;
  excludeUsing: number;
  createTrigger: number;
};

/** Counted from the eight migration files; each count is re-derived below. */
const EXPECTED_COUNTS: Counts = {
  createType: 19,
  createTable: 31,
  foreignKey: 54,
  createIndex: 79,
  uniqueIndex: 20,
  check: 2,
  excludeUsing: 2,
  createTrigger: 1,
};

const COUNT_PATTERNS: Record<keyof Counts, RegExp> = {
  createType: /CREATE\s+TYPE\b/gi,
  createTable: /CREATE\s+TABLE\b/gi,
  foreignKey: /FOREIGN\s+KEY\b/gi,
  // The 77 is the total; `uniqueIndex` is the 20-element subset inside it.
  createIndex: /CREATE\s+(?:UNIQUE\s+)?INDEX\b/gi,
  uniqueIndex: /CREATE\s+UNIQUE\s+INDEX\b/gi,
  check: /\bCHECK\s*\(/gi,
  excludeUsing: /\bEXCLUDE\s+USING\b/gi,
  createTrigger: /CREATE\s+TRIGGER\b/gi,
};

type LaneRow = { lane: string; cells: string[] };

type BaselineReport = {
  /** Everything directly under `prisma/migrations`, files included. */
  entries: string[];
  migrationDirs: string[];
  missingSql: string[];
  emptySql: string[];
  counts: Counts;
  laneStatements: number;
  laneRows: LaneRow[];
  /** `path:line` for every reference to `prisma/sql` in EXECUTABLE text. */
  codeReferences: string[];
  sqlDirPresent: boolean;
};

/**
 * Blank out comments, preserving offsets and newlines so a hit can still be
 * reported at its original line. `--` for SQL/Prisma, `//` for TypeScript.
 * A string literal that names `prisma/sql` survives this on purpose: a path
 * used by code is a live dependency, not provenance prose.
 */
function stripComments(text: string, kind: "sql" | "code" | "none"): string {
  const block = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (kind === "sql") return block.replace(/--[^\n]*/g, "");
  if (kind === "code") return block.replace(/\/\/[^\n]*/g, "");
  return block;
}

function commentKind(file: string): "sql" | "code" | "none" {
  // Prisma's schema language comments with `//` and `///`, not with `--`.
  if (file.endsWith(".sql")) return "sql";
  if (file.endsWith(".prisma") || /\.[cm]?[jt]sx?$/.test(file)) return "code";
  return "none";
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Split one VALUES list into its top-level row tuples. */
function splitRows(values: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    const ch = values[i];
    if (ch === "'") {
      const close = values.indexOf("'", i + 1);
      i = close === -1 ? values.length : close;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        rows.push(values.slice(start, i).trim());
        start = -1;
      }
    }
  }
  return rows;
}

/** Split one row tuple into its column cells (array commas are not separators). */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "'") {
      const close = row.indexOf("'", i + 1);
      i = close === -1 ? row.length : close;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      cells.push(row.slice(start, i).trim());
      start = i + 1;
    }
  }
  cells.push(row.slice(start).trim());
  return cells;
}

/** Every `INSERT INTO "workitem_lane"` statement and the rows it carries. */
function extractLaneRows(sql: string): { statements: number; rows: LaneRow[] } {
  const marker = /INSERT\s+INTO\s+"workitem_lane"/i;
  const rows: LaneRow[] = [];
  let statements = 0;
  let from = 0;
  for (;;) {
    const rest = sql.slice(from);
    const hit = marker.exec(rest);
    if (!hit) break;
    const start = from + hit.index;
    const end = sql.indexOf(";", start);
    const statement = sql.slice(start, end === -1 ? undefined : end);
    statements += 1;
    const valuesAt = statement.search(/\bVALUES\b/i);
    if (valuesAt !== -1) {
      for (const raw of splitRows(statement.slice(valuesAt + "VALUES".length))) {
        const cells = splitCells(raw);
        const lane = /^'([A-Z_]+)'$/.exec(cells[0] ?? "")?.[1] ?? "<unparsable>";
        rows.push({ lane, cells });
      }
    }
    from = end === -1 ? sql.length : end + 1;
  }
  return { statements, rows };
}

function inspect(prismaDir: string): BaselineReport {
  const migrationsDir = join(prismaDir, "migrations");
  const entries = readdirSync(migrationsDir).sort();
  const migrationDirs = entries.filter((entry) =>
    statSync(join(migrationsDir, entry)).isDirectory(),
  );

  const missingSql: string[] = [];
  const emptySql: string[] = [];
  const stripped: string[] = [];

  for (const dir of migrationDirs) {
    const file = join(migrationsDir, dir, "migration.sql");
    if (!existsSync(file)) {
      missingSql.push(dir);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") emptySql.push(dir);
    stripped.push(stripComments(text, "sql"));
  }

  const sql = stripped.join("\n");
  const counts = {} as Counts;
  for (const key of Object.keys(COUNT_PATTERNS) as (keyof Counts)[]) {
    counts[key] = (sql.match(COUNT_PATTERNS[key]) ?? []).length;
  }

  let laneStatements = 0;
  const laneRows: LaneRow[] = [];
  for (const text of stripped) {
    const found = extractLaneRows(text);
    laneStatements += found.statements;
    laneRows.push(...found.rows);
  }

  const codeReferences: string[] = [];
  for (const file of walkFiles(prismaDir)) {
    const kind = commentKind(file);
    const executable = stripComments(readFileSync(file, "utf8"), kind);
    let at = executable.indexOf("prisma/sql");
    while (at !== -1) {
      const line = executable.slice(0, at).split("\n").length;
      codeReferences.push(`${relative(prismaDir, file).replace(/\\/g, "/")}:${line}`);
      at = executable.indexOf("prisma/sql", at + 1);
    }
  }

  return {
    entries,
    migrationDirs,
    missingSql,
    emptySql,
    counts,
    laneStatements,
    laneRows,
    codeReferences,
    sqlDirPresent: existsSync(join(prismaDir, "sql")),
  };
}

/** Every defect the baseline must not have. Empty means the tree is a baseline. */
function problems(report: BaselineReport): string[] {
  const found: string[] = [];

  const expectedEntries = [...CANONICAL_DIRS, "migration_lock.toml"].sort();
  if (JSON.stringify(report.entries) !== JSON.stringify(expectedEntries)) {
    found.push(
      `migration directory entries are ${JSON.stringify(report.entries)}, expected exactly ${JSON.stringify(expectedEntries)}`,
    );
  }
  if (JSON.stringify(report.migrationDirs) !== JSON.stringify([...CANONICAL_DIRS])) {
    found.push(
      `migration directories are ${JSON.stringify(report.migrationDirs)}, expected the canonical eight in order`,
    );
  }
  if (report.sqlDirPresent) {
    found.push(
      "prisma/sql/ is still present: the fragments were folded into the chain and must not sit beside it",
    );
  }
  for (const dir of report.missingSql) found.push(`${dir} has no migration.sql`);
  for (const dir of report.emptySql) found.push(`${dir}/migration.sql is empty`);

  for (const key of Object.keys(EXPECTED_COUNTS) as (keyof Counts)[]) {
    if (report.counts[key] !== EXPECTED_COUNTS[key]) {
      found.push(`baseline-wide ${key} is ${report.counts[key]}, expected ${EXPECTED_COUNTS[key]}`);
    }
  }

  if (report.laneStatements !== 1) {
    found.push(
      `workitem_lane is inserted into by ${report.laneStatements} statement(s), expected exactly 1`,
    );
  }
  if (report.laneRows.length !== 5) {
    found.push(`workitem_lane carries ${report.laneRows.length} lane row(s), expected exactly 5`);
  }
  if (
    JSON.stringify(report.laneRows.map((row) => row.lane)) !== JSON.stringify([...CANONICAL_LANES])
  ) {
    found.push(
      `lane vocabulary is ${JSON.stringify(report.laneRows.map((row) => row.lane))}, expected ${JSON.stringify([...CANONICAL_LANES])}`,
    );
  }
  for (const row of report.laneRows) {
    if (row.cells.length !== 3) {
      found.push(`lane row ${row.lane} has ${row.cells.length} column(s), expected 3`);
      continue;
    }
    for (const [index, label] of [
      [1, "task_statuses"],
      [2, "ticket_statuses"],
    ] as const) {
      const cell = row.cells[index] as string;
      if (/^NULL$/i.test(cell) || !cell.startsWith("ARRAY[")) {
        found.push(
          `lane ${row.lane} ${label} is ${cell}: every lane cell must be an ARRAY constructor, never NULL`,
        );
      }
    }
  }
  const inReview = report.laneRows.find((row) => row.lane === "IN_REVIEW");
  if (inReview && inReview.cells[2] !== "ARRAY[]::text[]") {
    found.push(
      `IN_REVIEW ticket_statuses is ${String(inReview.cells[2])}, expected ARRAY[]::text[] (no ticket status in that lane)`,
    );
  }

  for (const ref of report.codeReferences) {
    found.push(`executable reference to the removed prisma/sql/ at ${ref}`);
  }

  return found;
}

/** Apply `mutate` to a throwaway copy of `prisma/` and inspect the copy. */
function inspectMutatedCopy(mutate: (prismaDir: string) => void): BaselineReport {
  const root = mkdtempSync(join(tmpdir(), "jiangtang-baseline-"));
  try {
    const prismaDir = join(root, "prisma");
    cpSync(join(PRISMA_DIR, "migrations"), join(prismaDir, "migrations"), { recursive: true });
    mutate(prismaDir);
    return inspect(prismaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LIVE = inspect(PRISMA_DIR);

describe("migration baseline (eight files, filesystem only — no database)", () => {
  it("holds exactly the eight canonical migration directories plus migration_lock.toml", () => {
    expect(LIVE.entries).toEqual([...CANONICAL_DIRS, "migration_lock.toml"].sort());
    expect(LIVE.migrationDirs).toEqual([...CANONICAL_DIRS]);
  });

  it("gives every migration directory a non-empty migration.sql", () => {
    expect(LIVE.missingSql).toEqual([]);
    expect(LIVE.emptySql).toEqual([]);
  });

  it("matches the baseline-wide statement counts", () => {
    expect(LIVE.counts).toEqual(EXPECTED_COUNTS);
  });

  it("ships exactly five lanes, and IN_REVIEW maps no ticket status", () => {
    expect(LIVE.laneStatements).toBe(1);
    expect(LIVE.laneRows.map((row) => row.lane)).toEqual([...CANONICAL_LANES]);
    const inReview = LIVE.laneRows.find((row) => row.lane === "IN_REVIEW");
    expect(inReview?.cells[2]).toBe("ARRAY[]::text[]");
    // …and no lane invents a status the enums do not carry: every cell is an
    // array, never NULL, which is what makes an unmapped status visible.
    for (const row of LIVE.laneRows) {
      expect(row.cells[1]).toMatch(/^ARRAY\[/);
      expect(row.cells[2]).toMatch(/^ARRAY\[/);
    }
  });

  it("has no prisma/sql directory and no executable reference to one", () => {
    expect(LIVE.sqlDirPresent).toBe(false);
    // Headers do not name `prisma/sql`, but comment-stripping is still what
    // separates a comment that mentions the path from a live dependency on it.
    expect(LIVE.codeReferences).toEqual([]);
  });

  it("the checker reports no problem on the live tree (the anchor for the controls below)", () => {
    expect(problems(LIVE)).toEqual([]);
  });
});

describe("migration baseline — negative controls (the same checker rejects a mutated copy)", () => {
  it("rejects a sixth lane row", () => {
    const report = inspectMutatedCopy((prismaDir) => {
      const file = join(prismaDir, "migrations", "20261023000500_workitem_view", "migration.sql");
      const before = readFileSync(file, "utf8");
      const anchor = "ARRAY['CANCELLED']);";
      const at = before.lastIndexOf(anchor);
      if (at === -1)
        throw new Error("negative control could not be applied: lane INSERT tail not found");
      const after =
        `${before.slice(0, at)}ARRAY['CANCELLED']),\n  ('SIXTH', ARRAY['SIXTH'], ARRAY['SIXTH']);` +
        before.slice(at + anchor.length);
      if (after === before)
        throw new Error("negative control could not be applied: copy unchanged");
      writeFileSync(file, after);
    });
    expect(problems(report)).toEqual(
      expect.arrayContaining([expect.stringContaining("lane row(s), expected exactly 5")]),
    );
  });

  it("rejects a removed index", () => {
    const report = inspectMutatedCopy((prismaDir) => {
      const dir = join(prismaDir, "migrations");
      for (const name of readdirSync(dir).sort()) {
        const file = join(dir, name, "migration.sql");
        if (!existsSync(file)) continue;
        const before = readFileSync(file, "utf8");
        const lines = before.split("\n");
        const at = lines.findIndex((line) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/.test(line));
        if (at === -1) continue;
        lines.splice(at, 1);
        const after = lines.join("\n");
        if (after === before)
          throw new Error("negative control could not be applied: copy unchanged");
        writeFileSync(file, after);
        return;
      }
      throw new Error("negative control could not be applied: no CREATE INDEX line found");
    });
    expect(problems(report)).toEqual(
      expect.arrayContaining([expect.stringContaining("baseline-wide createIndex is 78")]),
    );
  });

  it("rejects an executable reference to the removed prisma/sql/ directory", () => {
    const report = inspectMutatedCopy((prismaDir) => {
      // `\i prisma/sql/…` is a psql include: a live dependency on the removed
      // directory, unlike a comment that merely mentions the path.
      const file = join(
        prismaDir,
        "migrations",
        "20261023000200_booking_constraints",
        "migration.sql",
      );
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n\\i prisma/sql/01_booking_exclusion_constraints.sql\n`,
      );
    });
    expect(problems(report)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("executable reference to the removed prisma/sql/"),
      ]),
    );
  });
});
