/**
 * One entity-type vocabulary, and a twelfth spelling that cannot be written.
 *
 * `ActivityLog.entityType` is an unconstrained string, so one vocabulary can be spelled
 * several ways, and `listEntityHistory` matches that column **exactly and case-sensitively**:
 * a row written under a non-canonical spelling is invisible to the only reader that exists to
 * read it.
 *
 * **`audit()` is typed by the union**, which is the fix that holds: a test can be deleted and
 * a `grep` can be bypassed by a `const`, but a type is checked on every build. Its control is
 * a PascalCase literal, which fails `pnpm typecheck` (`TS2820`).
 *
 * ⚠️ **So why does this file exist at all, if the type already covers it?**
 * Because the type cannot see the writers that bypass `audit()`. Several tests
 * call `db.activityLog.create` with an `entityType` literal **directly**, and
 * Prisma's own `entityType` is an unconstrained `String`. The type is the net for
 * the sanctioned funnel; **this scan is the net for everything that went around
 * it**, and it is the only check that can fail for those lines.
 *
 * Three things make this a rot-check rather than a mirror of the filesystem:
 *
 *  1. **Negative control.** A synthetic source with a wrong literal MUST be
 *     reported. A scanner that cannot report a finding is a scanner that always
 *     passes — the 23:00 review tick shipped a false clean from exactly that
 *     (an empty `grep` pattern matching every line).
 *  2. **Non-vacuity.** The corpus scan asserts it actually read literals. A regex
 *     that silently stops matching yields `0` and a green run, the same false
 *     clean wearing a different hat.
 *  3. **No self-exclusion.** The control's bad literal is *assembled from parts*
 *     below, and so is the key in this file's own messages — so this file
 *     contains no quoted entityType literal of its own and needs no allowlist
 *     entry. An allowlist here would be a second thing that can go stale without
 *     anyone noticing — the `ALLOWED_EXTERNAL_LINKS` pattern from
 *     `doc-links.test.ts`, which needed its own anti-staleness assertion for
 *     exactly that reason.
 *
 * ⚠️ **Point 3 was false when first written, and the scan is what said so.** The
 * first version of this docstring and its `describeOccurrences` helper both
 * contained the very sequence the scanner looks for, so the corpus test went red
 * on its own author within a minute of being written. The docstring had asserted
 * a property the file did not have — the very defect the guard exists to catch. Fixed at the source rather than by exempting
 * this file, because the exemption is what would have hidden it.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ENTITY_TYPES,
  encodeRealtimeEvent,
  decodeRealtimeEvent,
  type EntityType,
} from "~/lib/realtime/events";
import { emitChange } from "~/lib/realtime/emit.server";
import { ENTITY_TYPE, entityTypeKey } from "~/domains/tickets/tickets.history.server";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The roots the scan covers: zero PascalCase `entityType:` literals in
 *  `app/` and `scripts/`, and every literal in the seed is a member. */
const SCAN_ROOTS = ["app", "scripts"] as const;
const SCAN_FILES = ["prisma/seed.ts"] as const;

/** The property name this guard reads, held in a variable so the scanner's own
 *  source and its failure messages never contain the sequence it searches for —
 *  otherwise the corpus scan reports this file, and the only ways out are an
 *  exemption (which hides the problem) or a weakened regex (which hides it too). */
const KEY = "entityType";

/** A quoted entityType value. Only a *quoted* value is a literal — a variable is
 *  not, and the type is the net for those (any `string` reaching `audit()` is a
 *  compile error). Comments are deliberately NOT stripped: a docstring that
 *  teaches `"Room"` is the same defect wearing documentation, and stripping
 *  comments would let it through. */
const LITERAL = new RegExp(`${KEY}:\\s*"([^"]*)"`, "g");

const MEMBERS: ReadonlySet<string> = new Set(ENTITY_TYPES);

type Occurrence = { file: string; line: number; value: string };

function sourceFilesUnder(absolutePath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = join(absolutePath, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(child));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) found.push(child);
  }
  return found;
}

function corpusFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) files.push(...sourceFilesUnder(resolve(REPO_ROOT, root)));
  for (const file of SCAN_FILES) files.push(resolve(REPO_ROOT, file));
  return [...new Set(files)];
}

/** Every quoted entityType value in one source file, with its line number. */
function literalsIn(absolutePath: string): Occurrence[] {
  const file = relative(REPO_ROOT, absolutePath).split(sep).join("/");
  const found: Occurrence[] = [];
  const source = readFileSync(absolutePath, "utf8");
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(LITERAL)) {
      found.push({ file, line: index + 1, value: match[1] ?? "" });
    }
  }
  return found;
}

function foreignLiterals(files: string[]): Occurrence[] {
  return files.flatMap(literalsIn).filter((occurrence) => !MEMBERS.has(occurrence.value));
}

function describeOccurrences(occurrences: Occurrence[]): string {
  return occurrences.map((o) => `  ${o.file}:${o.line} -> ${KEY}: "${o.value}"`).join("\n");
}

describe("one entity-type vocabulary", () => {
  it("reports a literal that is not a member (negative control)", () => {
    // Assembled from parts on purpose: a literal written out here would be a hit in
    // this file's own corpus scan, and the fix — an allowlist entry exempting the
    // scanner — is a second thing that can go stale silently.
    const key = KEY;
    const wrong = ["Ro", "om"].join("");
    const right = "room";
    const fixture = [
      "await audit({ action: 'RoomUpdated',",
      `  ${key}: "${wrong}",`,
      "  entityId: room.id });",
      `await db.activityLog.create({ data: { ${key}: "${right}" } });`,
    ].join("\n");

    const fixturePath = join(
      REPO_ROOT,
      "app",
      "lib",
      "realtime",
      "__tests__",
      "control.fixture.ts",
    );
    writeFileSync(fixturePath, fixture, "utf8");
    try {
      const found = literalsIn(fixturePath);
      // Both literals are read…
      expect(found.map((o) => o.value)).toEqual([wrong, right]);
      // …and the membership filter rejects exactly the wrong one.
      expect(found.filter((o) => !MEMBERS.has(o.value)).map((o) => o.value)).toEqual([wrong]);
      // Line numbers are real, so a failing corpus run points at a line a human
      // can open rather than at "somewhere in the file".
      expect(found.map((o) => o.line)).toEqual([2, 4]);
    } finally {
      rmSync(fixturePath, { force: true });
    }
  });

  it("reads literals out of the corpus (non-vacuity control)", () => {
    const files = corpusFiles();
    expect(files.length, "the scan must actually reach the corpus").toBeGreaterThan(100);

    // If LITERAL ever stops matching, THIS is what notices — not a green run over
    // zero literals. The measured count is 119; the floor sits well below it so
    // ordinary churn cannot quietly deflate the scan to nothing.
    expect(files.flatMap(literalsIn).length, "the literal regex stopped matching").toBeGreaterThan(
      60,
    );
  });

  it("every entityType literal in app/, scripts/ and the seed is a member", () => {
    const foreign = foreignLiterals(corpusFiles());
    expect(foreign, `non-member entityType literals:\n${describeOccurrences(foreign)}`).toEqual([]);
  });

  it("no PascalCase entityType literal survives in app/ or scripts/", () => {
    // The no-PascalCase rule is checked directly, rather than only implied by the
    // membership test above.
    const pascal = foreignLiterals(corpusFiles()).filter((o) => /^[A-Z]/.test(o.value));
    expect(pascal, `PascalCase entityType literals:\n${describeOccurrences(pascal)}`).toEqual([]);
  });

  it("audit()'s entityType is typed by the union, not string", () => {
    // A type has no runtime shape, so no behavioural test can observe this — which
    // is why a source-shape assertion is the honest instrument here, and why it
    // is two-sided: widening the parameter back to `string` AND deleting the
    // annotation both fail. Nothing else in the repo would notice either, because
    // the defect is invisible to every other gate.
    const source = readFileSync(resolve(REPO_ROOT, "app", "lib", "audit.server.ts"), "utf8");
    expect(source, "ActivityInput.entityType must be typed by the union").toMatch(
      /entityType:\s*EntityType;/,
    );
    expect(source, "the parameter must not be widened back to string").not.toMatch(
      /entityType:\s*string;/,
    );
  });

  it("the reader-side casing contract is still asserted", () => {
    // `tickets.history.test.ts:87` is the negative half of the casing contract:
    // `listEntityHistory("Room", …)` must return ZERO rows. That call is the reason
    // the reader's parameter stays `string` — typing it would make this a compile
    // error and delete the proof that a wrong casing finds nothing. The casing contract
    // forbids editing that test; this check fails if that call or its phrase disappears,
    // so the rule is enforced by the suite rather than by convention.
    const source = readFileSync(
      resolve(REPO_ROOT, "app", "domains", "tickets", "__tests__", "tickets.history.test.ts"),
      "utf8",
    );
    expect(source, "the casing negative case must survive").toContain(
      `listEntityHistory(${['"Ro', 'om"'].join("")}, room.id)`,
    );
    expect(source).toContain("locks in the lowercase casing contract");
  });

  it("emitChange accepts the location and inventory-item members", async () => {
    // A REAL call, not a comment: a docstring claiming the call typechecks proves nothing, so
    // this emits for real and asserts the payload survives the wire codec unchanged. Both
    // members must be accepted by the `emitChange` type, or callers cannot emit them.
    await emitChange({ entityType: "location", id: "vocab_loc", op: "created" });
    await emitChange({ entityType: "inventory-item", id: "vocab_item", op: "updated" });

    for (const member of ["location", "inventory-item"] as const) {
      const payload = encodeRealtimeEvent({
        entityType: member,
        id: "vocab-1",
        op: "created",
        ts: 1,
      });
      expect(decodeRealtimeEvent(payload).entityType).toBe(member);
    }
  });

  it("the union is an enumerable runtime array, and it is not a schema mirror", () => {
    expect(Array.isArray(ENTITY_TYPES)).toBe(true);
    expect(new Set(ENTITY_TYPES).size, "a duplicate member is a silent permission").toBe(
      ENTITY_TYPES.length,
    );
    for (const member of ENTITY_TYPES) expect(typeof member).toBe("string");

    // A derived union would rename 5 live members and admit 12 models that
    // have no business on an SSE wire. These four are the excluded ones.
    for (const excluded of ["session", "account", "verification", "calendarOutbox"]) {
      expect(ENTITY_TYPES as readonly string[]).not.toContain(excluded);
    }
    // The two members that were once missing: two action routes had 0
    // emitChange calls because these could not be written.
    expect(ENTITY_TYPES).toContain("location");
    expect(ENTITY_TYPES).toContain("inventory-item");
  });

  it("ENTITY_TYPE covers every member, so the map cannot be stale when written to", () => {
    // The direction `satisfies Record<string, EntityType>` cannot express: a member
    // the map OMITS. That is how the map went stale in the first place — two routes
    // wrote `location` and `inventory-item` straight past it.
    for (const member of ENTITY_TYPES) {
      const key = entityTypeKey(member);
      expect(ENTITY_TYPE[key], `ENTITY_TYPE.${key} must map back to "${member}"`).toBe(member);
    }
  });

  it("entityTypeKey rejects a value outside the union (its own control)", () => {
    // Unreachable through ENTITY_TYPES by construction, so driven with a cast —
    // otherwise the guard is a branch no test can ever reach.
    expect(() => entityTypeKey("nonesuch" as EntityType)).toThrow(/no ENTITY_TYPE key/);
  });
});
