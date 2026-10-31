import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import { bulkCreateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { createModel } from "~/domains/catalog/catalog.mutations.server";
import type { EquipmentCsvRow } from "~/domains/inventory/inventory.schema";
import { ValidationError } from "~/lib/errors.server";

/**
 * `catalog/` owns the `EquipmentModel` create, the import's own transaction
 * carries it, and the find-then-create shape survives the move.
 * One guard per acceptance criterion:
 *
 *   (1) `inventory/` contains no `tx.equipmentModel.` call                    → tests 1–4
 *   (2) ATOMICITY — the create runs in the import's transaction, so the batch's
 *       own rows are all-or-nothing, scoped by this run's name token          → tests 5–7
 *   (3) the find-then-create shape survives — on the CALLER's `tx`, and it stays
 *       CASE-INSENSITIVE                                                          → tests 8–12
 *   (4) the `EquipmentModelCreated` row keeps `viaImport: true`, same tx       → tests 13–16
 *   (5) no migration, no fragment directory, no schema change                 → test 17
 *
 * 🔴 **Why the counts are scoped to a run-unique NAME TOKEN and never stated as
 * globals**: the `EquipmentModel` table starts empty — the seed is *forbidden*
 * to write one (`prisma/seed.ts:80` `UNTOUCHED_TABLES`) — so
 * `expect(count).toBe(0)` on the table passes **vacuously** — it certifies the
 * fixture, not the code. And a
 * literal on the audit table is a number no test can own: the suite appends to
 * `ActivityLog` on every run, and the correct global value moved 657 → 660 while
 * the change was being built. Scoping by `name` (not by `entityId`) is forced too — a
 * rolled-back batch yields no ids to scope by.
 *
 * 🔴 **The criterion-1 scan reads the WHOLE FOLDER, not one file — and its BREADTH
 * is ASSERTED, derived from the directory, in the first arm of that describe.**
 * The rule binds on the domain *folder*, not on one hand-picked file: a
 * folder-wide claim whose instrument reads one file of three proves nothing,
 * since a scan that cannot look returns the same answer as a scan that finds
 * nothing, so what gives those arms meaning is an assertion that the scan read
 * EVERY `.server.ts`, not a reach proven once at build time and then left to
 * prose.
 * 🔴 **The sibling arm below proves the DETECTOR, never the scan's REACH** — it
 * matches strings and never calls `inventoryFolder()` — and is named for exactly
 * that, so nothing here credits it with a reach it does not have.
 *
 * ⚠️ **Every arm owns its own token, and `afterEach` sweeps between arms.** This
 * is not tidiness — it is measured. A control probe that turns one arm red leaves
 * that arm's rows behind, and with a single shared scope token the residue makes
 * the NEXT arm red for the wrong reason: a failed case-variant batch cascaded
 * into the "no model text" arm, which reported a dedup failure while testing
 * something else entirely. A guard whose other arms move is a guard that reports
 * a cause the reader cannot see.
 *
 * ActivityLog is append-only: nothing here deletes an audit row, and every
 * assertion is scoped to this run's token.
 */

const RUN = `b21_${Date.now().toString(36)}`;
const actor = { id: null, name: "Import Tester", initials: "IT" };

/** One token per arm, so no arm can read another arm's rows. */
const T = {
  ctl: `${RUN}_ctl`,
  roll: `${RUN}_roll`,
  caseSensitive: `${RUN}_case`,
  sameName: `${RUN}_same`,
  noText: `${RUN}_notext`,
  reuse: `${RUN}_reuse`,
  flag: `${RUN}_flag`,
  manual: `${RUN}_manual`,
} as const;

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const inventoryFile = read("../../inventory/inventory.mutations.server.ts");
const catalogFile = read("../catalog.mutations.server.ts");
const queriesFile = read("../catalog.queries.server.ts");

/**
 * Every `.server.ts` in `inventory/` — the guard binds on the folder, not on the
 * single file that happens to hold today's write.
 *
 * 🔴 **The scan returns the NAMES it read beside the joined source, and those
 * names are the keys of the very map whose values were concatenated** — so "the
 * names the scan read" and "the source the scan saw" cannot drift apart. A name
 * absent from the content is not assertable, and content present under a name the
 * caller is never told about would be unreadable ground the guard cannot vouch for.
 */
const inventoryFolder = (): { names: string[]; source: string } => {
  const dir = fileURLToPath(new URL("../../inventory/", import.meta.url));
  const bodies = new Map<string, string>();
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".server.ts"))
    .sort()) {
    bodies.set(f, readFileSync(`${dir}${f}`, "utf8"));
  }
  return {
    names: [...bodies.keys()],
    source: [...bodies].map(([f, body]) => `// ${f}\n${body}`).join("\n"),
  };
};

/**
 * 🔴 The set the scan MUST have read — derived HERE, from its own `readdirSync`
 * and its own filter literal, and **never from the scan's own list**.
 *
 * 🔴 **The two filter predicates are deliberately DUPLICATED rather than shared,
 * and that duplication is the assertion's whole point.** A shared predicate would
 * narrow the expectation and the scan together, so the comparison would stay green
 * through exactly the narrowing it exists to catch.
 * The comparison also rejects the three static alternatives for the same reason:
 * `toContain` asserts a *subset*, a literal nine goes red on a legitimate tenth
 * file, and a bare count cannot detect a *swap*.
 */
const inventoryServerFileNames = (): string[] =>
  readdirSync(fileURLToPath(new URL("../../inventory/", import.meta.url)))
    .filter((f) => f.endsWith(".server.ts"))
    .sort();

/** The body of one exported function, so "the import path" is not "the whole file". */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} must still exist`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + signature.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

const findOrCreateBody = functionBody(catalogFile, "export async function findOrCreateModel");
const bulkCreateBody = functionBody(inventoryFile, "export async function bulkCreateEquipment");

/** A `tx.<model>.<write>` call — the shape writer table is keyed on. */
const equipmentModelWrite = /\btx\.equipmentModel\./;
/** The case-insensitive name match. Absent ⇒ the lookup lost its semantics. */
const insensitiveNameLookup = /findFirst\(\s*\{[\s\S]*?mode:\s*"insensitive"/;
/** A read on a second connection — the defect this guard is about. */
const secondConnectionRead = /\bdb\.equipmentModel\./;

/** The earlier shape: the inline create `inventory/` used to build itself. */
const PRE_B21_BODY = [
  "      let modelId: string | null = null;",
  "      if (row.modelText) {",
  "        const existing = await tx.equipmentModel.findFirst({",
  '          where: { name: { equals: row.modelText, mode: "insensitive" } },',
  "          select: { id: true },",
  "        });",
  "        if (existing) {",
  "          modelId = existing.id;",
  "        } else {",
  "          const model = await tx.equipmentModel.create({ data: { name: row.modelText, category: row.category } });",
  "        }",
  "      }",
].join("\n");

/**
 * The design rejects this reuse: a perfectly well-formed `tx`-taking signature whose
 * BODY reads on a second connection. It carries a case-insensitive name match, so
 * it satisfies every check a signature-level reading can make.
 */
const REJECTED_DB_LOOKUP_BODY = [
  "export async function findOrCreateModel(tx, audit, input) {",
  "  const existing = await db.equipmentModel.findFirst({",
  '    where: { name: { equals: input.name, mode: "insensitive" } },',
  "    select: { id: true },",
  "  });",
  "  if (existing) return existing.id;",
  "  const model = await tx.equipmentModel.create({ data: { name: input.name, category: input.category } });",
  "  return model.id;",
  "}",
].join("\n");

/**
 * A call counter on the writer under test. Hoisted for `vi.mock`, and it
 * DELEGATES — the real function runs, so every write and every audit row below is
 * a real one, not a recorded call. It exists for exactly one claim that a
 * token-scoped query cannot express (test 12).
 */
const calls = vi.hoisted(() => ({ findOrCreate: 0 }));
vi.mock("~/domains/catalog/catalog.mutations.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/domains/catalog/catalog.mutations.server")>();
  return {
    ...actual,
    findOrCreateModel: async (...args: Parameters<typeof actual.findOrCreateModel>) => {
      calls.findOrCreate += 1;
      return actual.findOrCreateModel(...args);
    },
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A POOLED row needs no room, which keeps the fixture on the model write itself. */
function pooled(
  modelText: string | undefined,
  over: Partial<EquipmentCsvRow> = {},
): EquipmentCsvRow {
  return {
    category: "PROJECTOR",
    modelText,
    roomText: undefined,
    mobility: "POOLED",
    status: "OPERATIONAL",
    name: undefined,
    assetTag: undefined,
    serial: undefined,
    hostname: undefined,
    ipAddress: undefined,
    macAddress: undefined,
    frequencyMhz: undefined,
    band: undefined,
    channelLabel: undefined,
    ...over,
  };
}

/** Models THIS run created, by the token in their name. */
const modelsWith = (token: string) =>
  db.equipmentModel.findMany({ where: { name: { contains: token } }, orderBy: { name: "asc" } });

/**
 * 🔴 `EquipmentModelCreated` rows THIS run created, by the token in `data->>'name'`.
 * Scoped by NAME, not `entityId` (a rollback yields no ids) and not by `viaImport`
 * (see test 16 for why that flag cannot be the discriminator).
 */
const auditRowsWith = (token: string) =>
  db.activityLog.findMany({
    where: { action: "EquipmentModelCreated", data: { path: ["name"], string_contains: token } },
    orderBy: { occurredAt: "asc" },
  });

/** Equipment units this run created, by the `-` token in their name. */
const unitsOf = (arm: string) =>
  db.equipment.findMany({ where: { name: { startsWith: `${RUN}-${arm}` } } });

/** ⚠️ Runs after EVERY arm, not once at the end — see the header. */
afterEach(async () => {
  await db.equipment.deleteMany({ where: { name: { startsWith: RUN } } });
  await db.equipmentModel.deleteMany({ where: { name: { contains: RUN } } });
});
beforeEach(() => {
  calls.findOrCreate = 0;
});
afterAll(async () => {
  await db.$disconnect();
});

// ── Criterion 1 — the write is owned by catalog/ ──────────────────────────────

describe("criterion 1 — inventory/ contains no EquipmentModel write", () => {
  it("(1) no file in inventory/ calls tx.equipmentModel.", () => {
    // The WHOLE FOLDER, not the one file that used to hold the create: the guard
    // binds on the folder, and a one-file guard would prove nothing.
    //
    // 🔴 The `toContain` that used to sit here is gone: it named ONE file, so a
    // scan of that one file satisfied it exactly as well as a scan of all nine —
    // a presence check wearing a scope check's clothes. Presence is now a
    // *consequence* of the breadth arm below rather than a claim in its own right.
    const folder = inventoryFolder();
    expect(folder.source).not.toMatch(equipmentModelWrite);
  });

  it("(1) BREADTH — the scan read EVERY .server.ts in inventory/ (derived-set equality by name)", () => {
    // 🔴 The only assertion in this file that can see the scan's
    // SCOPE. Measured both directions on this exact guard: appending a live
    // `tx.equipmentModel.` write to a real sibling, then narrowing the scan to one
    // file, left all 18 tests GREEN with the violation sitting unread.
    const folder = inventoryFolder();
    const expected = inventoryServerFileNames();
    // Non-vacuity FIRST: a filter narrowed to nothing matches an empty expectation
    // perfectly, so the derived set is asserted non-empty before it is compared.
    // A control that can only fail on an empty corpus proves nothing about a real one.
    expect(
      expected.length,
      "the derived set must be non-empty or the comparison below is vacuous",
    ).toBeGreaterThan(0);
    // Named in the failure, because "the folder" is not a place a reader can look —
    // and it names EVERY file the scan read, not merely the one that differs.
    expect(
      folder.names,
      `the scan must read every .server.ts in inventory/ — it read [${folder.names.join(", ")}], expected [${expected.join(", ")}]`,
    ).toEqual(expected);
    // …and the names are not a report about the source: each one must be a real
    // segment of what was concatenated, so a caller cannot be told a file was read.
    for (const name of folder.names) {
      expect(folder.source, `${name} must appear in the scanned content`).toContain(`// ${name}`);
    }
  });

  it("(1) the two filter predicates stay textually separate — the duplication IS the assertion", () => {
    // 🔴 The docstring above calls this duplication
    // "the assertion's whole point" and NOTHING enforced it: hoisting the predicate
    // into one shared const — the tidy-up that docstring warns against — narrows
    // the scan and the expectation TOGETHER, and every other arm here stays green.
    //
    // 🔴 The needle is ASSEMBLED, never written as a literal: this assertion reads
    // its OWN source from disk, so a literal spelling would put this test inside the
    // count it computes. Measured: a literal reads 3 — red on arrival.
    const self = read("./catalog.import-model.test.ts");
    const quote = String.fromCharCode(34);
    const needle = ".endsWith(" + quote + ".server.ts" + quote + ")";

    const copies: number[] = [];
    for (let i = self.indexOf(needle); i !== -1; i = self.indexOf(needle, i + 1)) copies.push(i);

    // Non-vacuity: 2 is a count this arm can lose, not a tautology.
    expect(
      copies,
      `the predicate must be written out twice, not shared — found ${copies.length}`,
    ).toHaveLength(2);

    // A bare count cannot tell a SWAP from a duplicate, so each copy is located by
    // the declaration enclosing it — anchored to the declaration, never to a line
    // number, because this test's own source moves both lines. Compared as a SET,
    // so moving one declaration past the other is not reported as a defect, but two
    // copies landing in ONE declaration still is.
    const enclosing = (index: number): string | undefined => {
      let nearest: string | undefined;
      let nearestAt = -1;
      for (const declaration of ["const inventoryFolder", "const inventoryServerFileNames"]) {
        const hit = self.lastIndexOf(declaration, index);
        if (hit !== -1 && hit > nearestAt) {
          nearestAt = hit;
          nearest = declaration;
        }
      }
      return nearest;
    };
    expect(
      copies.map(enclosing).sort(),
      "one copy in each declaration, and not both in one",
    ).toEqual(["const inventoryFolder", "const inventoryServerFileNames"].sort());
  });

  it("(1) the import path calls catalog/'s writer and builds no model of its own", () => {
    expect(bulkCreateBody).toContain("findOrCreateModel(tx, audit");
    expect(bulkCreateBody).not.toMatch(equipmentModelWrite);
    expect(bulkCreateBody).not.toContain("tx.equipmentModel");
  });

  it("(1) CONTROL — the DETECTOR fires on sibling-shaped source; this arm does NOT prove the scan's reach", () => {
    // 🔴 Renamed to what it actually proves, and the over-claim is gone.
    // This arm matches STRINGS and never calls `inventoryFolder()`, so it certifies
    // the DETECTOR. The REACH is proved by the breadth arm above, which derives its
    // set from the real directory. This arm used to be NAMED as the reach control
    // and this header used to credit it with the reach — both false
    // in the same direction: a literal is by construction not a member of the unit
    // under test, so no arrangement of strings here can show what the scan reads.
    //
    // Two levels, and the second is the one an earlier guard was missing.
    //
    // Pattern arm: a literal proves the DETECTOR matches.
    expect(PRE_B21_BODY, "the detector must fire on the pre-B21 shape").toMatch(
      equipmentModelWrite,
    );
    // Same shape under a sibling's NAME — the closest a string comes to the real
    // thing. What it proves is that the detector does not care which file in the
    // folder the text is attributed to; what it cannot prove is that any file is
    // ever attributed at all.
    const siblingShaped = "// inventory.stock.mutations.server.ts\n" + PRE_B21_BODY;
    expect(
      siblingShaped,
      "the detector must not care which file the shape is attributed to",
    ).toMatch(equipmentModelWrite);
    // And the sanctioned call must trip none of them, or the guard is unfalsifiable.
    const sanctioned =
      "        const modelId = await findOrCreateModel(tx, audit, { name: row.modelText });";
    expect(sanctioned).not.toMatch(equipmentModelWrite);
  });

  it("(1) the writer it calls is catalog/'s, and modelExists was NOT reused", () => {
    // `modelExists` reads `db.`, takes no `tx`, and is case-sensitive +
    // manufacturer-scoped. Building the find half on it satisfies the letter of
    // "catalog/ owns the write" while reintroducing the second-connection defect
    // inside the body — so this arm is the one that catches it.
    expect(findOrCreateBody).not.toContain("modelExists");
    expect(findOrCreateBody).not.toMatch(secondConnectionRead);
    // …and it is left exactly as it was, because createModel/updateModel still use it.
    expect(queriesFile).toMatch(/export async function modelExists\(/);
    expect(catalogFile).toMatch(
      /if \(await modelExists\(input\.manufacturer \?\? null, input\.name\)\)/,
    );
    expect(catalogFile).toMatch(
      /if \(await modelExists\(input\.manufacturer \?\? null, input\.name, id\)\)/,
    );
  });
});

// ── Criterion 2 — the create runs in the import's transaction ─────────────────

describe("criterion 2 — the batch is atomic, scoped to its own name token", () => {
  it("(2) CONTROL — the same batch with no failing row DOES create a model and its audit row", async () => {
    // The positive arm. Without it, "0 models with the token" in the next test is
    // indistinguishable from a token that simply never matched anything.
    const { created } = await bulkCreateEquipment(actor, [pooled(`Epson EB-S50 ${T.ctl}`)]);
    expect(created).toBe(1);
    expect(
      await modelsWith(T.ctl),
      "the control must create a model this query can find",
    ).toHaveLength(1);
    expect(
      await auditRowsWith(T.ctl),
      "the control must write an audit row this query can find",
    ).toHaveLength(1);
  });

  it("(2) a batch whose LATER row fails leaves 0 models and 0 audit rows for its token", async () => {
    // Row 1 creates a model; row 2 is FIXED against a room that does not exist,
    // which the import rejects with a ValidationError INSIDE the transaction.
    // A real rollback — no mock, no fault injection, nothing to distrust.
    const rows = [
      pooled(`Epson EB-S50 ${T.roll}`, { name: `${RUN}-roll-1` }),
      pooled(undefined, {
        name: `${RUN}-roll-2`,
        mobility: "FIXED",
        roomText: `${RUN}_no_such_room`,
      }),
    ];
    let caught: unknown;
    try {
      await bulkCreateEquipment(actor, rows);
    } catch (error) {
      caught = error;
    }
    expect(caught, "the unknown room must reach the caller").toBeInstanceOf(ValidationError);
    // The control reached write #1 before the difference bites, or the probe says
    // nothing about the batch: one model was created and then rolled back.
    expect(calls.findOrCreate, "the failing row must come after a model write").toBe(1);

    // Scoped to THIS batch's token, never a global count.
    expect(await modelsWith(T.roll), "the model from row 1 must be rolled back").toHaveLength(0);
    expect(await auditRowsWith(T.roll), "a rolled-back model must leave no audit row").toHaveLength(
      0,
    );
    // And the equipment itself, so the arm is not passing because the batch never ran.
    expect(await unitsOf("roll")).toHaveLength(0);
  });

  it("(2) the writer takes a tx and opens no transaction of its own", () => {
    // The literal reading — call createModel(actor, input) — would pass
    // every other test in this file and silently commit the model outside the
    // batch's rollback. Nothing else here can see it.
    expect(findOrCreateBody).not.toContain("txWithAudit");
    expect(findOrCreateBody).not.toContain("$transaction");
    expect(findOrCreateBody).toMatch(/findOrCreateModel\(\s*tx: Tx,\s*audit: AuditFn/);
    // The rejected shape is rejected for exactly ONE reason — the connection. It
    // is otherwise well-formed, and crucially it still creates on the caller's
    // `tx`, which is why a signature-level reading cannot tell it apart and why
    // the atomicity arm above stays GREEN under it.
    expect(REJECTED_DB_LOOKUP_BODY, "its LOOKUP reads a second connection").toMatch(
      secondConnectionRead,
    );
    expect(REJECTED_DB_LOOKUP_BODY, "its CREATE is still on the caller's tx").toMatch(
      /\btx\.equipmentModel\./,
    );
    expect(REJECTED_DB_LOOKUP_BODY, "and it is case-insensitive, so case cannot detect it").toMatch(
      insensitiveNameLookup,
    );
  });
});

// ── Criterion 3 — find-then-create, on the caller's tx, still case-insensitive ─

describe("criterion 3 — the find-then-create shape survives the move", () => {
  it("(3) the lookup is a tx-prefixed, case-insensitive findFirst before the create", () => {
    expect(findOrCreateBody).toMatch(insensitiveNameLookup);
    // The ORDER is the behaviour: look, then create, then audit. A create ahead of
    // the lookup is "always create", which is what the presence control rules out.
    const lookupAt = findOrCreateBody.indexOf("findFirst");
    const createAt = findOrCreateBody.indexOf("tx.equipmentModel.create");
    const auditAt = findOrCreateBody.indexOf('action: "EquipmentModelCreated"');
    expect(lookupAt, "the lookup must exist").toBeGreaterThan(-1);
    expect(lookupAt, "the lookup must come before the create").toBeLessThan(createAt);
    expect(createAt, "the create must come before the audit").toBeLessThan(auditAt);
    expect(findOrCreateBody).not.toMatch(secondConnectionRead);
  });

  it("(3) CONTROL — presence is necessary and NOT sufficient; the two semantics controls vary one axis each", () => {
    // Presence: drop the lookup and the body is detected. Retained from the old
    // row and DEMOTED — passing it proves the lookup EXISTS, not what it matches
    // or which connection it reads. Both mutations below still pass every
    // presence-style check, and only the two behavioural arms catch them.
    const noLookup = findOrCreateBody.replace(insensitiveNameLookup, '{ where: { id: "x" } }');
    expect(noLookup).not.toMatch(insensitiveNameLookup);
    // Axis 1 — case: a tx-based lookup that is case-SENSITIVE. Caught by test 11.
    const caseSensitive = findOrCreateBody.replace(
      insensitiveNameLookup,
      "findFirst({ where: { name: input.name } })",
    );
    expect(caseSensitive, "presence is satisfied by the case-SENSITIVE mutation").toMatch(
      /findFirst/,
    );
    expect(caseSensitive).not.toMatch(insensitiveNameLookup);
    // Axis 2 — connection: the rejected reuse, case-sensitivity held CONSTANT.
    // Caught by test 10. A control that varied both axes at once would be caught
    // by either arm and would prove neither.
    expect(REJECTED_DB_LOOKUP_BODY, "the axis-2 control holds case-insensitivity fixed").toMatch(
      insensitiveNameLookup,
    );
    expect(REJECTED_DB_LOOKUP_BODY).toMatch(secondConnectionRead);
  });

  it("(3) an IDENTICAL-name pair reuses one model — 🔴 this is the arm the connection control needs", async () => {
    // 🔴 **Two rows naming the IDENTICAL string.** This is the control asked for
    // and that no other arm here could express: it is the only
    // one that varies the CONNECTION while holding case constant.
    //
    // Probed, not reasoned: routing the lookup through a non-`tx` `db.` read does
    // not turn criterion (2) — the ATOMICITY arm — red. It cannot: the create is
    // still on the caller's `tx`, so the rollback still rolls back. A live
    // `db.`-based-lookup probe left every criterion-2 test GREEN and reddened only
    // the structural arms plus the case-variant arm, which it failed for the wrong
    // reason (it could not see row 1's uncommitted model, not that it mismatched
    // its case).
    //
    // What actually breaks is DEDUP WITHIN a batch: a model created by row 1 is
    // uncommitted, so a second connection cannot see it, and row 2 creates a
    // second model — silently, with no error anywhere.
    const { created } = await bulkCreateEquipment(actor, [
      pooled(`Epson EB-S50 ${T.sameName}`, { name: `${RUN}-same-1` }),
      pooled(`Epson EB-S50 ${T.sameName}`, { name: `${RUN}-same-2` }),
    ]);
    expect(created).toBe(2);

    const models = await modelsWith(T.sameName);
    expect(models, "two rows naming one model must create it once").toHaveLength(1);
    // And both units carry it, so the count above is REUSE and not a skipped row.
    const units = await unitsOf("same");
    expect(units).toHaveLength(2);
    expect(new Set(units.map((u) => u.modelId))).toEqual(new Set([models[0].id]));
  });

  it("(3) a case-variant pair — `Epson EB-S50` + `epson eb-s50` — yields EXACTLY ONE model", async () => {
    // 🔴 The property the import has and the DATABASE does not. The only unique
    // object on the table is an INDEX on (manufacturer, name); the import writes
    // no manufacturer, so it is NULL on 100 % of imported models, where repeated
    // NULLs are DISTINCT to Postgres; and the index is case-sensitive on both
    // columns. So this lookup is stricter than the constraint on both axes, and a
    // case-SENSITIVE implementation creates a second model with nothing failing.
    const { created } = await bulkCreateEquipment(actor, [
      pooled(`Epson EB-S50 ${T.caseSensitive}`, { name: `${RUN}-case-1` }),
      pooled(`epson eb-s50 ${T.caseSensitive}`, { name: `${RUN}-case-2` }),
    ]);
    expect(created).toBe(2);

    const models = await modelsWith(T.caseSensitive);
    expect(
      models.map((m) => m.name),
      "the FIRST spelling is the one kept",
    ).toEqual([`Epson EB-S50 ${T.caseSensitive}`]);
    const units = await unitsOf("case");
    expect(units).toHaveLength(2);
    expect(new Set(units.map((u) => u.modelId))).toEqual(new Set([models[0].id]));

    // PRECONDITION, and the reason this arm is a real test rather than an
    // assertion about the fixture: if the DATABASE rejected the case-variant
    // pair, a case-sensitive lookup would throw instead of duplicating, and this
    // test could not distinguish the two. The rows are allowed, not required —
    // only their EXISTENCE as a distinct pair matters.
    const distinct = await db.equipmentModel.findMany({
      where: {
        name: { in: [`Epson EB-S50 ${T.caseSensitive}`, `epson eb-s50 ${T.caseSensitive}`] },
      },
      select: { name: true },
    });
    expect(
      distinct.length,
      "the database does not forbid the case-variant pair",
    ).toBeLessThanOrEqual(1);
  });

  it("(3) a row with no model text never reaches the writer, and carries a null modelId", async () => {
    // 🔴 Asserted on the CALL COUNT rather than on a table count, and that is the
    // point: a row with no `modelText` creates no model, so there is no name to
    // scope a query by — and a global count here is exactly the vacuous assertion
    // The design rejects it, because a *global* count is also a number another suite
    // running in parallel can move. The twin arm below is what gives it meaning.
    const { created } = await bulkCreateEquipment(actor, [
      pooled(undefined, { name: `${RUN}-notext-1`, category: "MICROPHONE" }),
    ]);
    expect(created).toBe(1);
    expect(calls.findOrCreate, "a row with no model text must not call the writer at all").toBe(0);
    const [unit] = await unitsOf("notext");
    expect(unit.modelId, "and the unit must carry no model reference").toBeNull();
  });

  it("(3) CONTROL — the call counter is not blind: a row WITH model text calls the writer once", async () => {
    // The twin of the arm above, on the same counter. A counter that never
    // increments would satisfy "0 times" for any implementation, including one
    // that never calls the writer at all.
    await bulkCreateEquipment(actor, [
      pooled(`Epson EB-S50 ${T.noText}`, { name: `${RUN}-notext-ctl` }),
    ]);
    expect(calls.findOrCreate, "the counter must see a real call").toBe(1);
    expect(await modelsWith(T.noText), "and that call really created a model").toHaveLength(1);
  });
});

// ── Criterion 4 — the audit row keeps its flag, in the same transaction ───────

describe("criterion 4 — the EquipmentModelCreated row", () => {
  it("(4) the created model carries viaImport: true and the caller's actor", async () => {
    await bulkCreateEquipment(actor, [pooled(`Epson EB-S50 ${T.flag}`, { name: `${RUN}-flag-1` })]);
    const rows = await auditRowsWith(T.flag);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("EquipmentModelCreated");
    expect(rows[0].entityType).toBe("equipmentModel");
    // The id is the model's own, so the row points at a real reader target.
    const [model] = await modelsWith(T.flag);
    expect(rows[0].entityId).toBe(model.id);
    expect(rows[0].data).toMatchObject({ name: `Epson EB-S50 ${T.flag}`, viaImport: true });
    expect(rows[0].actorSnapshot).toMatchObject({ initials: "IT" });
  });

  it("(4) exactly ONE audit row per created model — a reused name writes none", async () => {
    await bulkCreateEquipment(actor, [
      pooled(`Epson EB-S50 ${T.reuse}`, { name: `${RUN}-reuse-1` }),
      pooled(`epson eb-s50 ${T.reuse}`, { name: `${RUN}-reuse-2` }),
    ]);
    expect(await unitsOf("reuse")).toHaveLength(2);
    expect(await modelsWith(T.reuse)).toHaveLength(1);
    // A second EquipmentModelCreated here is the signature of a create that did
    // not consult the lookup — and it is a DIFFERENT signature from a duplicate
    // model row, because the two can disagree.
    expect(await auditRowsWith(T.reuse)).toHaveLength(1);
  });

  it("(4) the manual catalog path is unchanged and still audits without the import flag", async () => {
    // The flip side of "this writer is the importer's": `createModel` is untouched
    // by this slice, keeps its own dedup and its own payload, and opens its own
    // transaction — which is correct for a manual create and wrong for a batch.
    const model = await createModel(actor, {
      manufacturer: undefined,
      name: `Epson EB-S50 ${T.manual}`,
      category: "PROJECTOR",
    });
    expect(await modelsWith(T.manual)).toHaveLength(1);
    const rows = await auditRowsWith(T.manual);
    expect(rows, "the manual path audits too").toHaveLength(1);
    expect(rows[0].data).toMatchObject({ name: `Epson EB-S50 ${T.manual}`, category: "PROJECTOR" });
    // …and it does NOT claim to have come from an import.
    expect(rows[0].data).not.toMatchObject({ viaImport: true });
    // The same slice must not have touched it: no second-connection read.
    expect(functionBody(catalogFile, "export async function createModel")).not.toMatch(
      secondConnectionRead,
    );
    expect(model.manufacturer).toBeNull();
  });

  it("(4) CONTROL — 🔴 the viaImport flag is NOT a usable discriminator, and both rows are created here", async () => {
    // 🔴 The second vacuity: `EquipmentModelCreated` rows created before
    // `viaImport` existed carry
    // `{"name": "OptiPlex", "category": "PC"}` with **no `viaImport` key at all**.
    // So a count scoped on `data ? 'viaImport'` filters away every real row and
    // passes. The name token is the only honest discriminator.
    //
    // Built from two rows THIS file created — the manual one above and an import
    // one — so the control does not depend on another suite having run first,
    // which a "flagged < total" assertion on the shared dev table would.
    const manual = await auditRowsWith(T.manual);
    const imported = await auditRowsWith(T.flag);
    expect(manual).toHaveLength(1);
    expect(imported).toHaveLength(1);
    const flagged = (rows: typeof manual) =>
      rows.filter((r) => (r.data as { viaImport?: unknown })?.viaImport === true);
    expect(flagged(manual), "a manual create carries no import flag").toHaveLength(0);
    expect(flagged(imported), "an import create does").toHaveLength(1);
    // So the flag filter and the name filter are DIFFERENT sets — the whole reason
    // every count in this file is scoped by name.
    expect(flagged([...manual, ...imported])).not.toEqual([...manual, ...imported]);
  });
});

// ── Criterion 5 — nothing structural moved ────────────────────────────────────

describe("criterion 5 — no migration, no fragment directory, no schema change", () => {
  it("(5) the shipped schema and the migration baseline are untouched by this slice", () => {
    // The hand-written fragments were folded into the seven-file baseline and
    // the directory that held them is GONE. Its absence is asserted rather than
    // its old file list, so a fragment directory reappearing beside the chain
    // fails here instead of quietly becoming a second source of schema truth.
    const prismaDir = fileURLToPath(new URL("../../../../prisma/", import.meta.url));
    expect(existsSync(join(prismaDir, "sql"))).toBe(false);
    // …and no migration directory was added BY THIS SLICE. Named in full
    // rather than counted: a bare count cannot be re-derived by whoever reads it
    // next, so a slice that does add one has to touch this line, which puts the
    // addition in the diff.
    const migrations = readdirSync(join(prismaDir, "migrations"))
      .filter((m) => m.startsWith("2026"))
      .sort();
    expect(migrations).toEqual([
      "20261023000000_extensions",
      "20261023000100_core_schema",
      "20261023000200_booking_constraints",
      "20261023000300_audit_privacy",
      "20261023000400_search_indexes",
      "20261023000500_workitem_view",
      "20261023000600_time_tracking_constraints",
    ]);
    // The writer introduced no column: EquipmentModel is unchanged, and the only
    // new symbol is a function.
    const schema = readFileSync(
      fileURLToPath(new URL("../../../../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    expect(schema).toMatch(/model EquipmentModel \{/);
    expect(findOrCreateBody).toMatch(
      /tx\.equipmentModel\.create\(\{\s*data: \{ name: input\.name, category: input\.category \},?\s*\}\)/,
    );
  });
});
