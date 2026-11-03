import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runPrefix } from "../e2e/run";
import globalTeardown from "../e2e/global-teardown";

// ---------------------------------------------------------------------------
// Mock layer proving that a missing run prefix causes ZERO DELETES and that
// ANOTHER RUN'S ROWS SURVIVE.
//
// The original suite never imported e2e/global-teardown.ts at all, so none of
// that was covered. `vi.hoisted` is used because `vi.mock` factories are
// hoisted above the module body — a factory closing over a plain `const spy =
// vi.fn()` fails with "ReferenceError: spy is not defined".
//
// The mocked `db` is not a canned return value: its `findMany` APPLIES the
// `startsWith` predicate against a fixed three-run corpus. So whether another
// run's rows survive is decided by the teardown's own filter, not by what the
// test chose to hand back. If the teardown ever widened to a broad `e2e-`
// sweep, the other runs' ids would flow into the delete spies and these
// assertions would fail.
//
// Mock targets use RELATIVE specifiers (`../app/...`) rather than the teardown's
// `~/...` alias: both resolve to the same absolute module id under the ordinary
// vitest config (which loads vite-tsconfig-paths), and the relative form also
// resolves with no alias plugin at all.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  type FakeRow = { id: string; title?: string; name?: string };
  type FindManyArgs = {
    where?: Record<string, { startsWith?: unknown } | undefined>;
    select?: unknown;
  };

  // Records whether each mocked module was ever IMPORTED. The prefix must be
  // resolved and validated BEFORE database imports, so a refusal must leave
  // these at zero — not merely leave the delete spies at zero.
  const imported = { db: 0, tasks: 0, notes: 0, projects: 0 };

  const deleteTask = vi.fn(async (_actor: unknown, _id: string) => undefined);
  const deleteNote = vi.fn(async (_actor: unknown, _id: string) => undefined);
  const deleteProject = vi.fn(async (_actor: unknown, _id: string) => undefined);

  const THIS_RUN = "e2e-aaa111-";
  const OTHER_RUN_A = "e2e-bbb222-";
  const OTHER_RUN_B = "e2e-ccc333-";

  const corpus: Record<"task" | "note" | "project", FakeRow[]> = {
    task: [
      { id: "task-this-1", title: `${THIS_RUN} first` },
      { id: "task-other-1", title: `${OTHER_RUN_A} other run` },
      { id: "task-this-2", title: `${THIS_RUN} second` },
      { id: "task-other-2", title: `${OTHER_RUN_B} another run` },
      { id: "task-plain", title: "an ordinary user task, no e2e prefix" },
    ],
    note: [
      { id: "note-this-1", title: `${THIS_RUN} note` },
      { id: "note-other-1", title: `${OTHER_RUN_A} note` },
      { id: "note-plain", title: "an ordinary user note" },
    ],
    project: [
      // projects are matched on `name`, not `title`
      { id: "project-this-1", name: `${THIS_RUN} project` },
      { id: "project-other-1", name: `${OTHER_RUN_A} project` },
      { id: "project-other-2", name: `${OTHER_RUN_B} project` },
      { id: "project-plain", name: "an ordinary user project" },
    ],
  };

  const admin = {
    id: "admin-1",
    name: "QA Admin",
    email: "qa-admin@example.invalid",
    initials: "QA",
  };

  function selectByPrefix(
    rows: FakeRow[],
    field: "title" | "name",
    args: unknown,
  ): Array<{ id: string }> {
    const where = (args as FindManyArgs).where;
    const startsWith = where?.[field]?.startsWith;
    if (typeof startsWith !== "string") {
      throw new Error(
        `fake db: teardown must scope ${field} by a string startsWith prefix, ` +
          `got ${JSON.stringify(where)}`,
      );
    }
    return rows
      .filter((r) => String(r[field] ?? "").startsWith(startsWith))
      .map((r) => ({ id: r.id }));
  }

  const db = {
    user: { findFirst: vi.fn(async (_args: unknown) => admin) },
    task: {
      findMany: vi.fn(async (args: unknown) => selectByPrefix(corpus.task, "title", args)),
    },
    note: {
      findMany: vi.fn(async (args: unknown) => selectByPrefix(corpus.note, "title", args)),
    },
    project: {
      findMany: vi.fn(async (args: unknown) => selectByPrefix(corpus.project, "name", args)),
    },
    $disconnect: vi.fn(async () => undefined),
  };

  return {
    imported,
    deleteTask,
    deleteNote,
    deleteProject,
    corpus,
    db,
    selectByPrefix,
    admin,
    THIS_RUN,
    OTHER_RUN_A,
    OTHER_RUN_B,
  };
});

vi.mock("../app/lib/db.server", () => {
  h.imported.db += 1;
  return { db: h.db };
});

vi.mock("../app/domains/tasks/tasks.mutations.server", () => {
  h.imported.tasks += 1;
  return { deleteTask: h.deleteTask };
});

vi.mock("../app/domains/notes/notes.mutations.server", () => {
  h.imported.notes += 1;
  return { deleteNote: h.deleteNote };
});

vi.mock("../app/domains/projects/projects.mutations.server", () => {
  h.imported.projects += 1;
  return { deleteProject: h.deleteProject };
});

const RUN_ID_PATH = "e2e/.run-id";

function writeRunId(value: string): void {
  mkdirSync("e2e", { recursive: true });
  writeFileSync(RUN_ID_PATH, value);
}

function removeRunId(): void {
  try {
    unlinkSync(RUN_ID_PATH);
  } catch {
    // already absent
  }
}

function clearTeardownSpies(): void {
  h.deleteTask.mockClear();
  h.deleteNote.mockClear();
  h.deleteProject.mockClear();
  h.db.user.findFirst.mockClear();
  h.db.task.findMany.mockClear();
  h.db.note.findMany.mockClear();
  h.db.project.findMany.mockClear();
  h.db.$disconnect.mockClear();
  // NOTE: h.imported.* is deliberately NOT reset here. A vi.mock factory runs
  // once per module per file, so the counter is cumulative; the refusal tests
  // assert it does not INCREASE across the call, which stays correct whether or
  // not an earlier test already imported the modules.
}

function importCounts(): Record<keyof typeof h.imported, number> {
  return { ...h.imported };
}

/** Ids actually handed to a delete spy (the second argument). */
function deletedIds(spy: { mock: { calls: Array<[unknown, string]> } }): string[] {
  return spy.mock.calls.map((c) => c[1]);
}

describe("runPrefix", () => {
  const runIdPath = "e2e/.run-id";

  beforeEach(() => {
    mkdirSync("e2e", { recursive: true });
  });

  afterEach(() => {
    try {
      unlinkSync(runIdPath);
    } catch {
      // File may not exist
    }
  });

  it("returns valid prefix for well-formed .run-id", () => {
    writeFileSync(runIdPath, "e2e-abc123-\n");
    expect(runPrefix()).toBe("e2e-abc123-");
  });

  it("throws when .run-id is missing", () => {
    try {
      unlinkSync(runIdPath);
    } catch {
      // Ignore if already missing
    }
    expect(() => runPrefix()).toThrow("e2e/.run-id not found or unreadable");
  });

  it("throws when .run-id has invalid format (no trailing dash)", () => {
    writeFileSync(runIdPath, "e2e-abc123");
    expect(() => runPrefix()).toThrow("invalid format");
  });

  it("throws when .run-id has invalid format (uppercase)", () => {
    writeFileSync(runIdPath, "e2e-ABC123-");
    expect(() => runPrefix()).toThrow("invalid format");
  });

  it("throws when .run-id has invalid format (special chars)", () => {
    writeFileSync(runIdPath, "e2e-abc-123-");
    expect(() => runPrefix()).toThrow("invalid format");
  });

  it("throws when .run-id is empty", () => {
    writeFileSync(runIdPath, "");
    expect(() => runPrefix()).toThrow("invalid format");
  });

  it("accepts e2e-local- only because it matches ^e2e-[a-z0-9]+-$ (no special-cased fallback remains)", () => {
    writeFileSync(runIdPath, "e2e-local-");
    // `e2e-local-` is a legal run id under the same pattern every other id must
    // satisfy — it is NOT special-cased. The fallback that synthesized
    // `e2e-local-` was removed from e2e/run.ts, so nothing creates this value any more; if
    // the file happens to contain it, runPrefix() accepts it by pattern alone.
    expect(runPrefix()).toBe("e2e-local-");
  });

  it("accepts valid format with numbers and lowercase letters", () => {
    writeFileSync(runIdPath, "e2e-a1b2c3-");
    expect(runPrefix()).toBe("e2e-a1b2c3-");
  });
});

describe("teardown safety", () => {
  it("runPrefix validates before any database operation", () => {
    // This test proves that runPrefix throws before any DB imports
    const runIdPath = "e2e/.run-id";
    try {
      unlinkSync(runIdPath);
    } catch {
      // Ignore
    }

    // Attempting to get prefix should throw before any DB code runs
    expect(() => runPrefix()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Teardown cases: drive the REAL e2e/global-teardown.ts against mocked
// db / deleteTask / deleteNote / deleteProject.
// ---------------------------------------------------------------------------
describe("global teardown sweep is run-scoped (mocks)", () => {
  beforeEach(() => {
    clearTeardownSpies();
    mkdirSync("e2e", { recursive: true });
  });

  afterEach(() => {
    removeRunId();
    clearTeardownSpies();
  });

  it("missing .run-id: rejects, ZERO deletes, and never imports the database module", async () => {
    removeRunId();
    const before = importCounts();

    await expect(globalTeardown()).rejects.toThrow("e2e/.run-id not found or unreadable");

    expect(h.deleteTask).not.toHaveBeenCalled();
    expect(h.deleteNote).not.toHaveBeenCalled();
    expect(h.deleteProject).not.toHaveBeenCalled();

    // The prefix must be resolved/validated BEFORE database imports.
    expect(h.imported).toEqual(before);
    expect(h.db.task.findMany).not.toHaveBeenCalled();
    expect(h.db.note.findMany).not.toHaveBeenCalled();
    expect(h.db.project.findMany).not.toHaveBeenCalled();
    expect(h.db.$disconnect).not.toHaveBeenCalled();
  });

  const MALFORMED: Array<[string, string]> = [
    ["empty file", ""],
    ["no trailing dash", "e2e-abc123"],
    ["uppercase run id", "e2e-ABC123-"],
    ["inner dash", "e2e-abc-123-"],
    ["empty run id / bare sweep prefix", "e2e-"],
    ["no e2e- prefix", "local"],
    ["underscore run id", "e2e-abc_123-"],
    ["trailing garbage after the dash", "e2e-abc123- x"],
  ];

  for (const [label, content] of MALFORMED) {
    it(`malformed .run-id (${label}): ZERO deletes and no database import`, async () => {
      writeRunId(content);
      const before = importCounts();

      await expect(globalTeardown(), label).rejects.toThrow("invalid format");

      expect(h.deleteTask, label).not.toHaveBeenCalled();
      expect(h.deleteNote, label).not.toHaveBeenCalled();
      expect(h.deleteProject, label).not.toHaveBeenCalled();
      expect(h.imported, `${label}: no module may be imported`).toEqual(before);
      expect(h.db.$disconnect, label).not.toHaveBeenCalled();
    });
  }

  it("a valid run id sweeps ONLY that run's rows; two other runs' rows survive", async () => {
    writeRunId(h.THIS_RUN);

    await globalTeardown();

    // This run's rows were deleted...
    expect(deletedIds(h.deleteTask).sort()).toEqual(["task-this-1", "task-this-2"]);
    expect(deletedIds(h.deleteNote)).toEqual(["note-this-1"]);
    expect(deletedIds(h.deleteProject)).toEqual(["project-this-1"]);

    // ...and no other run's rows, and no un-prefixed user rows, were touched.
    const everyDeletedId = [
      ...deletedIds(h.deleteTask),
      ...deletedIds(h.deleteNote),
      ...deletedIds(h.deleteProject),
    ];
    for (const survivor of [
      "task-other-1",
      "task-other-2",
      "task-plain",
      "note-other-1",
      "note-plain",
      "project-other-1",
      "project-other-2",
      "project-plain",
    ]) {
      expect(everyDeletedId, `${survivor} must survive`).not.toContain(survivor);
    }
    expect(everyDeletedId).toHaveLength(4);

    // Cleanup still ran.
    expect(h.db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("each of the three queries is scoped by the EXACT generated prefix, never a broad 'e2e-' sweep", async () => {
    writeRunId(h.THIS_RUN);

    await globalTeardown();

    expect(h.db.task.findMany).toHaveBeenCalledWith({
      where: { title: { startsWith: h.THIS_RUN } },
      select: { id: true },
    });
    expect(h.db.note.findMany).toHaveBeenCalledWith({
      where: { title: { startsWith: h.THIS_RUN } },
      select: { id: true },
    });
    // projects are matched on `name`
    expect(h.db.project.findMany).toHaveBeenCalledWith({
      where: { name: { startsWith: h.THIS_RUN } },
      select: { id: true },
    });

    for (const spy of [h.db.task.findMany, h.db.note.findMany, h.db.project.findMany]) {
      const prefix = (
        spy.mock.calls[0][0] as {
          where: Record<string, { startsWith: string }>;
        }
      ).where;
      const value = Object.values(prefix)[0].startsWith;
      expect(value).toBe(h.THIS_RUN);
      expect(value).not.toBe("e2e-");
      expect(value).toMatch(/^e2e-[a-z0-9]+-$/);
    }
  });

  it("METAMORPHIC: a different valid run id sweeps a different row set", async () => {
    // Proves the prefix actually DRIVES selection, rather than the corpus being
    // arranged to flatter one particular run id. Same teardown, same fake data,
    // only .run-id differs -> the surviving and deleted sets swap.
    writeRunId(h.OTHER_RUN_A);

    await globalTeardown();

    expect(deletedIds(h.deleteTask)).toEqual(["task-other-1"]);
    expect(deletedIds(h.deleteNote)).toEqual(["note-other-1"]);
    expect(deletedIds(h.deleteProject)).toEqual(["project-other-1"]);

    const everyDeletedId = [
      ...deletedIds(h.deleteTask),
      ...deletedIds(h.deleteNote),
      ...deletedIds(h.deleteProject),
    ];
    for (const survivor of [
      "task-this-1",
      "task-this-2",
      "task-other-2",
      "note-this-1",
      "project-other-2",
    ]) {
      expect(everyDeletedId, `${survivor} must survive`).not.toContain(survivor);
    }
    expect(everyDeletedId).toHaveLength(3);
  });

  it("CONTROL: the fake query engine WOULD return other runs' rows to a broad sweep", () => {
    // Without this, "other runs survive" could be an artifact of a fake that
    // only ever returns this run's rows. Ask the same engine for the broad
    // `e2e-` prefix that teardown must never use, and confirm it hands back
    // every run.
    const broad = h.selectByPrefix(h.corpus.task, "title", {
      where: { title: { startsWith: "e2e-" } },
    });
    expect(broad.map((r) => r.id)).toEqual([
      "task-this-1",
      "task-other-1",
      "task-this-2",
      "task-other-2",
    ]);
    expect(broad.map((r) => r.id)).toContain("task-other-1");

    const scoped = h.selectByPrefix(h.corpus.task, "title", {
      where: { title: { startsWith: h.THIS_RUN } },
    });
    expect(scoped.map((r) => r.id)).toEqual(["task-this-1", "task-this-2"]);
  });

  it("CONTROL: the import counters and delete spies are capable of recording", async () => {
    // Guards the zero-delete / no-import assertions above against a mis-wired
    // mock, and does so differentially so it cannot pass vacuously:
    //   (1) a successful sweep DOES import all four modules and DOES delete;
    //   (2) immediately afterwards, a refusal moves the SAME counters by zero.
    // A counter that only ever went up, or only ever stayed flat, fails one of
    // the two halves.
    //
    // Note: `vi.resetModules()` does NOT re-run a `vi.mock` factory in Vitest
    // (the mocked module value is cached separately from the module registry),
    // so the counters are cumulative per file and are compared as deltas rather
    // than reset to zero.
    writeRunId(h.THIS_RUN);
    await globalTeardown();

    expect(h.deleteTask).toHaveBeenCalledTimes(2);
    expect(h.deleteNote).toHaveBeenCalledTimes(1);
    expect(h.deleteProject).toHaveBeenCalledTimes(1);
    expect(h.imported.db).toBeGreaterThanOrEqual(1);
    expect(h.imported.tasks).toBeGreaterThanOrEqual(1);
    expect(h.imported.notes).toBeGreaterThanOrEqual(1);
    expect(h.imported.projects).toBeGreaterThanOrEqual(1);

    clearTeardownSpies();
    removeRunId();
    const beforeRefusal = importCounts();
    await expect(globalTeardown()).rejects.toThrow("e2e/.run-id not found or unreadable");
    expect(h.imported).toEqual(beforeRefusal);
    expect(h.deleteTask).not.toHaveBeenCalled();
    expect(h.deleteNote).not.toHaveBeenCalled();
    expect(h.deleteProject).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Containment of a failed delete must NOT mean silence. The sweep still
  // has to finish every row of every collection and still has to disconnect —
  // and then the teardown must REJECT with a summary, so Playwright reports a
  // failed global teardown (playwright@1.63.0 maps a teardown-task throw to
  // status "failed" and exit code 1) instead of a green run that left stale
  // `e2e-<runId>-` rows behind.
  //
  // These assertions deliberately do NOT depend on `console.warn`. The warn is
  // muted only to keep test output readable; no expectation is placed on it, so
  // removing or renaming the warn cannot flip the verdict either way. The
  // evidence is the rejection, the delete spies and the disconnect spy.
  //
  // DIFFERENTIAL PAIR (why these cannot pass vacuously):
  //   * this test: one delete fails  -> teardown REJECTS, sweep still completed;
  //   * the zero-failure CONTROL below: nothing fails -> teardown RESOLVES.
  // Delete the summary throw from e2e/global-teardown.ts and this test fails.
  // Make the throw unconditional and the CONTROL fails.
  // -------------------------------------------------------------------------
  it("a delete failure is contained, the remaining sweeps still run, AND the teardown REJECTS with a summary", async () => {
    writeRunId(h.THIS_RUN);
    h.deleteTask.mockRejectedValueOnce(new Error("synthetic delete failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let thrown: Error | undefined;
    try {
      thrown = await globalTeardown().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    } finally {
      warn.mockRestore();
    }

    // (1) The run is NOT green: the teardown rejected with the summary.
    expect(thrown, "teardown must reject when a delete failed").toBeInstanceOf(Error);
    expect(thrown?.message).toContain("[e2e teardown] cleanup incomplete");
    expect(thrown?.message).toContain(h.THIS_RUN);
    expect(thrown?.message).toContain("task=1");
    expect(thrown?.message).toContain("task:task-this-1");
    // Labels and ids only — never row contents. The corpus titles are row
    // content; if any of them leaked into the message this would fail.
    expect(thrown?.message).not.toContain(`${h.THIS_RUN} first`);
    expect(thrown?.message).not.toContain(`${h.THIS_RUN} second`);
    expect(thrown?.message).not.toContain(h.admin.email);

    // (2) Containment still holds: the failed row did not stop the rest of the
    //     sweep. BOTH task rows were attempted, and notes/projects still ran.
    expect(deletedIds(h.deleteTask).sort()).toEqual(["task-this-1", "task-this-2"]);
    expect(deletedIds(h.deleteNote)).toEqual(["note-this-1"]);
    expect(deletedIds(h.deleteProject)).toEqual(["project-this-1"]);

    // (3) The new failure path did not widen the sweep.
    const everyDeletedId = [
      ...deletedIds(h.deleteTask),
      ...deletedIds(h.deleteNote),
      ...deletedIds(h.deleteProject),
    ];
    for (const survivor of [
      "task-other-1",
      "task-other-2",
      "task-plain",
      "note-other-1",
      "note-plain",
      "project-other-1",
      "project-other-2",
      "project-plain",
    ]) {
      expect(everyDeletedId, `${survivor} must survive`).not.toContain(survivor);
    }
    expect(everyDeletedId).toHaveLength(4);

    // (4) `db.$disconnect()` still ran — and ran AFTER the last delete, which is
    //     only possible if the `finally` completed before the summary was thrown.
    expect(h.db.$disconnect).toHaveBeenCalledTimes(1);
    const lastDeleteOrder = Math.max(
      ...h.deleteTask.mock.invocationCallOrder,
      ...h.deleteNote.mock.invocationCallOrder,
      ...h.deleteProject.mock.invocationCallOrder,
    );
    expect(h.db.$disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(lastDeleteOrder);
  });

  it("failures in TWO collections are aggregated into one summary and the last sweep still runs", async () => {
    // A failure in a MIDDLE collection must not abort the remaining one, and the
    // thrown summary must cover every failure, not just the first. Both arms are
    // one-shot and are consumed by the single note/project row of this run, so
    // nothing leaks into later tests.
    writeRunId(h.THIS_RUN);
    h.deleteNote.mockRejectedValueOnce(new Error("synthetic note failure"));
    h.deleteProject.mockRejectedValueOnce(new Error("synthetic project failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let thrown: Error | undefined;
    try {
      thrown = await globalTeardown().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    } finally {
      warn.mockRestore();
    }

    expect(thrown, "teardown must reject when deletes failed").toBeInstanceOf(Error);
    expect(thrown?.message).toContain("[e2e teardown] cleanup incomplete");
    expect(thrown?.message).toContain("2 delete(s) failed");
    expect(thrown?.message).toContain("note=1");
    expect(thrown?.message).toContain("project=1");
    expect(thrown?.message).toContain("note:note-this-1");
    expect(thrown?.message).toContain("project:project-this-1");

    // The task sweep (which ran BEFORE both failures) succeeded and is not in the
    // summary; the project sweep (which ran AFTER both) was still attempted.
    expect(deletedIds(h.deleteTask).sort()).toEqual(["task-this-1", "task-this-2"]);
    expect(deletedIds(h.deleteNote)).toEqual(["note-this-1"]);
    expect(deletedIds(h.deleteProject)).toEqual(["project-this-1"]);
    expect(thrown?.message).not.toContain("task:");
    expect(h.db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("CONTROL (zero failures): with every delete succeeding the teardown RESOLVES, so the summary throw is conditional", async () => {
    // The other half of the differential pair. Without it, an unconditional
    // throw (or a throw on a wrong condition) would satisfy the rejection test
    // above while breaking every green run.
    writeRunId(h.THIS_RUN);

    await expect(globalTeardown()).resolves.toBeUndefined();

    // Not vacuous: the sweep genuinely ran, so "resolves" is not "did nothing".
    expect(deletedIds(h.deleteTask).sort()).toEqual(["task-this-1", "task-this-2"]);
    expect(deletedIds(h.deleteNote)).toEqual(["note-this-1"]);
    expect(deletedIds(h.deleteProject)).toEqual(["project-this-1"]);
    expect(h.db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("CONTROL (differential): the fake delete can actually fail, so the rejection above is not an artifact", async () => {
    // Guards the assertions against a mis-wired mock. Two properties are
    // required for those assertions to mean anything:
    //   (a) `mockRejectedValueOnce` really makes a delete reject — if the arming
    //       were a no-op, the teardown would see zero failures and any "rejects"
    //       assertion could only have passed for an unrelated reason;
    //   (b) the arm is ONE-shot — so in the test the remaining rows really
    //       do succeed, which is what makes "the remaining sweeps still run" a
    //       containment claim rather than an artifact of every delete failing.
    const probe = vi.fn(async (_actor: unknown, _id: string) => undefined);
    probe.mockRejectedValueOnce(new Error("synthetic delete failure"));
    await expect(probe({}, "first")).rejects.toThrow("synthetic delete failure");
    await expect(probe({}, "second")).resolves.toBeUndefined();

    // Same mechanism on the actual mocked delete spy the teardown imports. Both
    // calls below drain the one-shot arm, so nothing leaks into other tests.
    h.deleteTask.mockRejectedValueOnce(new Error("synthetic delete failure"));
    await expect(h.deleteTask({}, "probe-a")).rejects.toThrow("synthetic delete failure");
    await expect(h.deleteTask({}, "probe-b")).resolves.toBeUndefined();
  });
});
