import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * CI GUARD.
 *
 * **Rule 7 binds on the domain folder**: a folder may read another
 * folder's `.server` module and call its exported functions, but *the code that
 * performs a write to a model is the code inside the folder that owns that
 * model*, and the audit row is written there, in that same transaction.
 *
 * The rule was originally written as prose with **no instrument**, and its
 * rot was named: the table "will rot the moment a fifth folder appears". This
 * file is that instrument. It is deliberately narrow — it never inspects what a
 * payload contains, only **who performs the write**.
 *
 * ### What is checked
 *
 * | rule | fails on |
 * |---|---|
 * | **model axis** (crit. 2) | `.<delegate>.<writeVerb>(` in a folder that does not own the model — **including through a delegate alias** |
 * | **unowned model** (crit. 1) | a write to one of the models the map records an explicit `null` for |
 * | **outside the map** (crit. 8) | a write from a prod file no folder key claims — a new top-level folder, or a component |
 * | **routes** (crit. 5) | any direct `db.` access in `app/routes/`, **read or write** (b) |
 * | **reach** (crit. 8) | a prod file the guard did not read, or a key whose folder it never walked |
 *
 * ### What is deliberately NOT checked, and why
 *
 * 1. **The column axis is not a violation axis.** The required-FK rule the
 *    guard was first sized with was rejected: it is inverted (it flags
 *    `EventRoomBooking.roomId` and `EquipmentAllocation.equipmentId`, the two
 *    join rows the contract requires) and it cannot tell a foreign key from an
 *    ownership claim. What replaced it is **builder-bypass** — a write to
 *    another folder's model that skips that folder's exported writer. That is
 *    *structurally* the model-axis detection: the sanctioned cross-folder call
 *    (`createEquipmentInTx(tx, audit, …)`) contains no delegate write at all, so
 *    it cannot be flagged. A dedicated check pins that, on the two calls that exist.
 *    The cross-folder FK column writes are deliberately **not** re-derived
 *    here: this guard has no consumer
 *    for a column list. Re-deriving it would add a second instrument whose number
 *    nothing checks.
 * 2. **The payload is not descended into.** `connect:` whose value is an
 *    expression, and spreads, are data rather than ownership.
 * 3. **No total is asserted as a literal.** A hand-typed site count would
 *    only restate the author's memory of the tree.
 *    Every number here is **derived from the scan** and compared to the
 *    walked file set, so a new writer changes nothing in this file.
 * 4. **A client alias is not resolved.** `const d = db; d.room.create(` is
 *    invisible to **both** detectors: `findWriteSites`' alias arm binds a
 *    *delegate* (`const c = tx.campus`), never a client, and `findRouteDbAccess`
 *    matches a literal `db.` followed by a member access, which `db;` is not.
 * 5. **Routes are on the model axis.** `tx.` and `prisma.` writes in a route are
 *    sites like any other and are judged against the folder that owns the model,
 *    so declaring `tx.`-blindness here would be declaring a falsehood the moment
 *    `app/routes` entered the map. Items 4 and 5 are the surviving pair, and
 *    `DECLARED_LIMITS` holds both to the detectors actually in use — item 5 so a
 *    narrowing turns red, item 4 so a widening does too. A check in one direction
 *    only could be satisfied by deleting the detector.
 * 6. **A read verb is not a write.** `tx.campus.findFirst(` is not a site, and
 *    that is a limit rather than an accident: the same multi-line scanner that
 *    now sees a chain split across lines must not start seeing reads.
 * 7. **A delegate that resolves to no model is not a delegate.**
 *    `tx.not_a_model.create(` is not a site, so a future model in the schema is
 *    the only thing that can make it one.
 *
 * ### The spellings the model-axis scanner resolves
 *
 * Ten idiomatic spellings of a single write were not seen by the previous
 * **line-scoped** scanner. Each is a `DECLARED_LIMITS` row now, so a
 * later narrowing turns red instead of quietly under-reading:
 *
 * - **A member chain broken across lines is seen.**
 * - **A delegate and its verb split across lines are seen.**
 * - **`tx!` is seen.**
 * - **`tx["campus"]` is seen.**
 * - **A `typeof` annotation still binds the alias.**
 * - **An `as` cast still binds the alias.**
 * - **A destructured delegate binds.**
 * - **A `let` and its later assignment bind as one alias.**
 * - **A binding split across lines binds.**
 * - **A bare assignment binds.**
 * - **Two consecutive `db.` lines are both seen.** — `findRouteDbAccess` loops
 *   `.test()` per line; a `/g` regex carries `lastIndex` across calls, so a
 *   shared `/g` instance reports only every other matching line.
 *
 * ⚠️ **`app/` contains none of the ten today** — checked over the whole walked
 * file set, whose site total is **unchanged** by this work — so these are
 * regression pins, not a defect report. What makes them load-bearing is that
 * items 6 and 7 are armed from the same change: a scanner that goes multi-line is
 * exactly the scanner that could start matching a read.
 *
 * ### Why the scanner is `ts.createScanner` and not a regex
 *
 * On the current tree, the three candidate instruments disagree, in
 * **opposite** directions: `//`-only blanking finds 62 sites, a naive block-
 * comment blanker finds 60, TypeScript's own scanner finds **61**. Both errors
 * are live here — `app/lib/audit.server.ts`'s JSDoc *example* contains a
 * `tx.ticket.update({ … })` (line-blanking counts it → a phantom), and
 * `app/lib/auth.boot.server.ts`'s string literal `"/api/auth/*"` opens a comment
 * that never closes under a naive blanker (**eats every write after it**). The
 * swallowed direction is the dangerous one: it reports green on a file it never
 * read. So the scan blanks with the authority, and a fixture asserts both traps.
 */

const REPO = resolve(process.cwd());

function toRepoPath(abs: string): string {
  return relative(REPO, abs).split(/[\\/]/).join("/");
}

const PROD_EXT = /\.tsx?$/;

/** Tests are fixtures for the code under test, not the code the rule is about. */
function isProdSource(rel: string): boolean {
  return !rel.includes("/__tests__/") && !/\.test\.tsx?$/.test(rel);
}

/** Recursive. Recursion is load-bearing — `app/lib` is a nested tree, not a folder. */
function walkProd(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir).sort()) {
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkProd(abs));
    else if (PROD_EXT.test(entry)) out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The map — folder → the models it owns.
// ---------------------------------------------------------------------------

/**
 * Keys are **the finest folder that owns something**, not every folder that
 * exists: `app/lib/calendar` is a key because `CalendarOutbox` has an owner
 * there, and the other `app/lib/*` subdirectories are covered by the `app/lib`
 * key. `app/domains` is flat, so its two query-only folders are keyed with an
 * **empty array** — a recorded answer, so the day one of them writes a model its
 * writer is already on the map and is judged against an owner rather than skipped.
 * `app/routes` is keyed the same way and for the same reason: it owns **no**
 * model, and it is on the model axis anyway, so a route's `tx.room.create(` is
 * judged against `app/domains/rooms` and reported rather than skipped.
 */
const FOLDERS: Record<string, readonly string[]> = {
  "app/domains/activity": [],
  "app/domains/analytics": [],
  "app/domains/api-tokens": ["PersonalAccessToken"],
  "app/domains/attachments": ["Attachment"],
  // Account, Session and TwoFactor are Better Auth's tables; the auth folder
  // writes them itself where a credential, sessions or a second factor must
  // change in an audited transaction (invite acceptance, password reset, the
  // admin two-factor reset, erasure).
  "app/domains/auth": ["User", "Verification", "Invitation", "Account", "Session", "TwoFactor"],
  "app/domains/board": [],
  "app/domains/catalog": ["EquipmentModel"],
  "app/domains/dashboard": [],
  "app/domains/events": ["Event", "EventRoomBooking", "EquipmentAllocation", "ServiceWindow"],
  "app/domains/inventory": ["Equipment", "InventoryItem"],
  "app/domains/locations": ["Location"],
  "app/domains/notes": ["Note"],
  "app/domains/notifications": ["Notification"],
  "app/domains/projects": ["Project"],
  "app/domains/rooms": ["Campus", "Building", "Room"],
  "app/domains/search": [],
  "app/domains/tasks": ["Task", "TaskAssignees", "TaskDependency"],
  "app/domains/tickets": ["Ticket"],
  "app/domains/time": ["TimeEntry"],
  // the import centre orchestrates in-tx writes but owns no model — the
  // owning folders' `importXInTx` functions carry every delegate call.
  "app/domains/transfer": [],
  "app/domains/vendors": ["Vendor"],
  // `app/lib` is a nested tree, not one folder. Top level owns ActivityLog;
  // calendar/ owns CalendarOutbox and MUST be its own key — a non-recursive read
  // of `app/lib` never opens it, and `CalendarOutbox`'s owner would be a map
  // entry no scan ever consulted.
  "app/lib": ["ActivityLog"],
  "app/lib/calendar": ["CalendarOutbox", "CalendarPublicationInitialization"],
  // the indexer owns the derived-data tables — Chunk/SearchIndexJob are
  // rebuilt from audited rows and carry no audit of their own.
  "app/lib/search": ["Chunk", "SearchIndexJob"],
  // `[]`, and **both halves of the map entry are load-bearing**. Routing a
  // route source through `findWriteSites` without this key turns the scope arm
  // red on arrival — `scopeOf` returns this same string, which was then no
  // `FOLDERS` key — and a repair whose first observable effect is a false red
  // teaches the next author to add an exemption. That is a
  // guard punishing the corpus for growing.
  "app/routes": [],
};

/**
 * The models no folder owns. **An explicit `null`, never an absent key.**
 * A guard that reads an absent key as "nobody owns it" lets the next
 * cross-folder write arrive silently — and the remaining entries are models
 * the tree has not written yet (`Project`, `Task`, `TaskAssignees`,
 * `TaskDependency`, `Account` and `Session` have moved out of this list into
 * their owning folders).
 */
const UNOWNED_MODELS = [] as const;

/** b: routes are scanned for direct `db.` access, read or write. */
const ROUTE_SCOPE = "app/routes";

/**
 * Prod source the guard deliberately does not open, each with a reason. A
 * non-generated file appearing here is a hole with a comment over it, and the
 * reach test below fails on anything not in this list.
 */
const UNSCANNED_ROOTS: Record<string, string> = {
  "app/generated":
    "Prisma 7's generated client source, rewritten by `pnpm db:generate` and ignored by ESLint. Machine-written: a rule about hand-written ownership cannot bind on it, and editing it is undone by the next generate.",
};

const TRANSACTION_ROOTS = new Set(["tx", "db", "prisma"]);

/** The write verbs. `$`-prefixed delegates (`$queryRaw`, `$transaction`) are not models. */
const WRITE_VERBS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

interface Exemption {
  readonly file: string;
  /** Why this file may cross a folder boundary. Never empty — an unnamed exception is a silence. */
  readonly reason: string;
}

/**
 * Exactly one carve-out FILE inside `app/domains/` is allowed,
 * named **by file**. The erasure path added a second sanctioned crossing inside
 * that same one file (gdpr.server.ts:64, Attachment); the file-level carve-out
 * count is still one.
 */
const MODEL_AXIS_EXEMPTIONS: readonly Exemption[] = [
  {
    file: "app/domains/auth/gdpr.server.ts",
    reason:
      "The GDPR erasure path is inherently cross-cutting (one person, personal links in every folder). The carve-out is from ownership only: the path still runs inside txWithAudit and writes its own ActivityLog row in the same transaction.",
  },
  {
    file: "app/lib/auth-bootstrap.server.ts",
    reason:
      "A once-ever boot-time admin promotion writes User from app/lib. Inside the universe, allow-listed by file so the exception is reviewable. Whether that promotion must also write an audit row is a known limitation.",
  },
  {
    file: "app/lib/auth.boot.server.ts",
    reason:
      "The dev-admin boot seed's db.user.update, same reasoning as auth-bootstrap.server.ts. One boot writer, two files, both named. Whether it must write an audit row is a known limitation, same as auth-bootstrap.server.ts.",
  },
];

const ROUTE_EXEMPTIONS: readonly Exemption[] = [
  {
    file: "app/routes/healthz/route.tsx",
    reason: "A liveness probe has no domain module and must reach the database itself.",
  },
];

// ---------------------------------------------------------------------------
// Schema + scanner
// ---------------------------------------------------------------------------

/** Model names straight from the schema — never a hand-typed list. */
function schemaModels(): string[] {
  const src = readFileSync(join(REPO, "prisma/schema.prisma"), "utf8");
  return [...src.matchAll(/^model\s+([A-Za-z]\w*)\s*\{/gm)].map((m) => m[1]!);
}

/** `Campus` → `campus`. Prisma's delegate is the model, first letter lowered. */
function buildDelegateIndex(models: readonly string[]): Map<string, string> {
  return new Map(models.map((m) => [m[0]!.toLowerCase() + m.slice(1).toLowerCase(), m]));
}

/**
 * Blank TypeScript comments with TypeScript's own scanner, **preserving line
 * numbers** (newlines survive, every other character becomes a space).
 */
export function blankComments(src: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    src,
  );
  const chars = [...src];
  let token: ts.SyntaxKind;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      for (let i = scanner.getTokenPos(); i < scanner.getTextPos(); i++) {
        if (chars[i] !== "\n") chars[i] = " ";
      }
    }
  }
  return chars.join("");
}

interface WriteSite {
  readonly file: string;
  readonly line: number;
  readonly model: string;
  readonly verb: string;
  readonly viaAlias: boolean;
}

/**
 * Character offset → line number, without a second pass over the source.
 *
 * the scan is **whole-source**, because a member chain split across lines
 * is still a member chain. That makes a site a character *offset* first and a
 * line second, so this conversion is what keeps a reported site pointing at the
 * line a reader will open. Binary search, since one file carries many offsets
 * and `blankComments` has already preserved the line count exactly.
 */
function lineStartsOf(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * `tx` / `db` / `prisma`, then **one** delegate however it is reached — after a
 * dot, after a non-null assertion, or through a bracket-quoted key. Two capture
 * groups because the two spellings are alternatives, and a caller takes
 * `m[2] ?? m[3]`.
 *
 * The delimiter before the delegate is `\s*` rather than `.`, which is what
 * closes the multi-line hole: a chain broken across lines is one expression, and
 * a line-scoped scan sees two unrelated lines.
 */
const ROOT_AND_DELEGATE = String.raw`(?:tx|db|prisma)\s*!?(?:\s*\.\s*([A-Za-z]\w*)|\s*\[\s*["']([A-Za-z]\w*)["']\s*\])`;

/** A trailing `as`/`satisfies` cast. The binding still names the same delegate. */
const CAST_SUFFIX = String.raw`(?:\s+(?:as|satisfies)\s+[^;,)]{0,120})?`;

/** What may follow a bound delegate: end of the binding, and nothing that reads. */
const ALIAS_TAIL = String.raw`\s*[;,)\n]`;

/**
 * `const|let|var name = <root>.<delegate>`, tolerating a type annotation between
 * the name and the `=` and a cast after it — `const c: typeof tx.campus =
 * tx.campus;` and `const c = tx.campus as Campus;` are the same binding written
 * two ways, and a scanner that reads only the bare form under-reads the second.
 */
const ALIAS_DECL_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]{0,160})?\s*=\s*(?:await\s+)?` +
    ROOT_AND_DELEGATE +
    CAST_SUFFIX +
    ALIAS_TAIL,
  "g",
);

/**
 * The same binding with **no declaration keyword**: `c = tx.campus;`. Anchored on
 * a preceding statement boundary so it cannot re-match the declaration form and
 * so an assignment inside an expression is not mistaken for a binding.
 */
const ALIAS_ASSIGN_RE = new RegExp(
  String.raw`(?:^|[;{},)\n])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?` +
    ROOT_AND_DELEGATE +
    CAST_SUFFIX +
    ALIAS_TAIL,
  "g",
);

/** `const { campus } = tx;` — the delegate keeps its own name at the call site. */
const ALIAS_DESTRUCTURE_RE =
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:tx|db|prisma)\s*[;,)\n]/g;

/** `tx.campus.create(` / `tx!.campus.create(` / `tx["campus"].create(` — any line breaks. */
const WRITE_CALL_RE = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*)\s*!?(?:\s*\.\s*([A-Za-z]\w*)|\s*\[\s*["']([A-Za-z]\w*)["']\s*\])\s*\.\s*([A-Za-z]\w*)\s*\(`,
  "g",
);

/** `c.create(` — a write through a bound delegate. */
const ALIAS_CALL_RE = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*)\s*!?(?:\s*\.\s*([A-Za-z]\w*))\s*\(`,
  "g",
);

/**
 * Every `tx.<model>.<writeVerb>(` / `db.…` / `prisma.…` in already-blanked
 * source, **with delegate aliases resolved** (`const c = tx.campus; c.create(…)`).
 *
 * The alias arm exists so the first alias introduced cannot silently escape the
 * guard. `app/` holds **zero** such bindings today, so the alias test runs
 * against a fixture — an arm with nothing to resolve is a control with nothing
 * to prove.
 *
 * Widened the **spelling** set, not the ownership rule: a chain may now be
 * broken across lines, a delegate may carry a `!` or a bracket key, and a binding
 * may be annotated, cast, destructured, split from its declaration or written as
 * a bare assignment. What it did **not** widen is what counts as a write — the
 * verb must be in `WRITE_VERBS` and the delegate must resolve to a model — so a
 * read verb and an unknown delegate stay unseen. That pair is pinned in both
 * directions by `DECLARED_LIMITS`, because a scanner going multi-line is exactly
 * the change that could start matching things it must not.
 */
export function findWriteSites(
  blanked: string,
  file: string,
  index: ReadonlyMap<string, string>,
): WriteSite[] {
  // Step 1 — bind aliases. The shape is `const c = tx.campus`, so the *model* is
  // baked into the binding and the call site is `c.create(` — TWO segments, not
  // three. Scanning only `<head>.<delegate>.<verb>(` therefore finds no alias
  // write at all, which is precisely the blind spot rule 2 exists to close.
  const aliasModel = new Map<string, string>();
  const bind = (name: string, delegate: string): void => {
    const model = index.get(delegate.toLowerCase());
    if (model) aliasModel.set(name, model);
  };
  for (const m of blanked.matchAll(ALIAS_DECL_RE)) bind(m[1]!, m[2] ?? m[3]!);
  for (const m of blanked.matchAll(ALIAS_ASSIGN_RE)) bind(m[1]!, m[2] ?? m[3]!);
  for (const m of blanked.matchAll(ALIAS_DESTRUCTURE_RE)) {
    // `{ campus }` binds `campus`; `{ campus: c }` binds `c` to the same model.
    for (const part of m[1]!.split(",")) {
      const pieces = part
        .split(":")
        .map((p) => p.trim())
        .filter(Boolean);
      const [delegate, name] = pieces.length > 1 ? pieces : [pieces[0], pieces[0]];
      if (delegate && name) bind(name, delegate);
    }
  }

  const sites: WriteSite[] = [];
  const starts = lineStartsOf(blanked);

  // Step 2 — a write through a delegate: `tx.campus.create(`.
  for (const m of blanked.matchAll(WRITE_CALL_RE)) {
    const [, head, dotDelegate, keyDelegate, verb] = m;
    if (!WRITE_VERBS.has(verb!)) continue;
    if (!TRANSACTION_ROOTS.has(head!)) continue;
    const model = index.get((dotDelegate ?? keyDelegate)!.toLowerCase());
    if (!model) continue;
    sites.push({ file, line: lineOf(starts, m.index!), model, verb: verb!, viaAlias: false });
  }

  // Step 3 — a write through an alias: `c.create(`.
  for (const m of blanked.matchAll(ALIAS_CALL_RE)) {
    const [, head, verb] = m;
    if (!WRITE_VERBS.has(verb!)) continue;
    const model = aliasModel.get(head!);
    if (!model) continue;
    sites.push({ file, line: lineOf(starts, m.index!), model, verb: verb!, viaAlias: true });
  }

  return sites.sort((a, b) => a.line - b.line);
}

interface DbAccess {
  readonly file: string;
  readonly line: number;
}

/** A direct `db.` access in a route is flagged, read or write, `$` methods included. */
function findRouteDbAccess(blanked: string, file: string): DbAccess[] {
  const out: DbAccess[] = [];
  // No `/g`: a stateful regex would carry `lastIndex` across `.test()`
  // calls and report only every other matching line.
  const re = /\bdb\.([A-Za-z_$][\w$]*)\s*[.(`]/;
  blanked.split("\n").forEach((line, i) => {
    if (re.test(line)) out.push({ file, line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// One scan over the whole universe
// ---------------------------------------------------------------------------

const MODELS = schemaModels();
const DELEGATES = buildDelegateIndex(MODELS);

/** Longest-prefix bucket. `app/lib/calendar` wins over `app/lib`. Null = unclaimed. */
function scopeOf(rel: string): string | null {
  if (rel.startsWith(`${ROUTE_SCOPE}/`)) return ROUTE_SCOPE;
  const keys = Object.keys(FOLDERS)
    .filter((k) => rel.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length);
  return keys[0] ?? null;
}

const ALL_PROD = walkProd(join(REPO, "app")).map(toRepoPath).filter(isProdSource);
const SCANNED_PROD = ALL_PROD.filter(
  (rel) => !Object.keys(UNSCANNED_ROOTS).some((r) => rel.startsWith(`${r}/`)),
);

/**
 * **Fed at the END of the scan loop on purpose.** The set means *"the loop
 * scanned this file"*, not *"the loop reached it"*, and that difference is the
 * whole content of the two census arms that check the scanned set.
 *
 * A `continue` between the top of the iteration and the scan skips a file while
 * still counting it as read, which is the blind spot the arm named *"names the
 * files it did not read"* exists to see. Checked with a probe: fed at the
 * top of the body, that narrowing leaves **both** census arms green; fed here,
 * the identical narrowing turns both red. **Do not move this line up.**
 */
const READ_FILES = new Set<string>();
const SITES: WriteSite[] = [];
const ROUTE_ACCESS: DbAccess[] = [];

/** The fixture's path must be a real route scope — `scopeOf` is what routes it. */
const ROUTE_FIXTURE_REL = "app/routes/__fixture__/route.ts";

/**
 * What the scan does with one file's blanked source. **One function, used by the
 * loop and by every fixture**, so a fixture exercises the path the corpus takes
 * and not a reimplementation of it — a fixture that calls `findWriteSites`
 * directly proves the detector, while the defect to avoid is a detector the
 * scan never reached.
 *
 * a route file goes through **both** detectors. Routing it through
 * `findRouteDbAccess` alone would let a `tx.`/`prisma.` write in a route reach neither
 * rule.
 */
function scanProdSource(
  blanked: string,
  rel: string,
): { readonly sites: WriteSite[]; readonly routeAccess: DbAccess[] } {
  return {
    sites: findWriteSites(blanked, rel, DELEGATES),
    routeAccess: scopeOf(rel) === ROUTE_SCOPE ? findRouteDbAccess(blanked, rel) : [],
  };
}

for (const rel of SCANNED_PROD) {
  const scan = scanProdSource(blankComments(readFileSync(join(REPO, rel), "utf8")), rel);
  SITES.push(...scan.sites);
  ROUTE_ACCESS.push(...scan.routeAccess);
  READ_FILES.add(rel);
}

interface DeclaredLimit {
  /** Stable id, named in the assertion that fails when the detectors move. */
  readonly id: string;
  /** The header sentence this row declares. Asserted present, so prose cannot drift. */
  readonly heading: string;
  /** In-test source — never `toContain` on a string, and no fixture on disk. */
  readonly fixture: readonly string[];
  /** What `findWriteSites` must report for `fixture`, driven through the route path. */
  readonly modelAxis: readonly string[];
  /**
   * Optional — the `[line, model]` pairs this row pins **as well as** the models.
   * `modelAxis` alone cannot catch a detector that reports the right models *from
   * the wrong lines*, so exactly the one row whose pairing is unique carries this
   * `undefined` and `[]` are different claims and must not collapse: the
   * loop asserts a pairing only when the field is present.
   */
  readonly modelAxisLines?: readonly (readonly [number, string])[];
  /** What `findRouteDbAccess` must report for the same source — the line numbers. */
  readonly routeAccess: readonly number[];
}

/**
 * The header's items 4 and 5, as data the suite checks **against the detectors
 * actually in use** — so a later widening or narrowing turns a test red instead of
 * silently falsifying the prose. A property
 * held only by the docstring is held by nothing.
 *
 * Both directions are armed, and that is the whole point. The `[]` rows fail if a
 * detector starts seeing a form the header says it cannot; the non-`[]` rows fail
 * if one stops seeing a form it does. **A one-directional check is satisfied by
 * deleting the detector.**
 */
const DECLARED_LIMITS: readonly DeclaredLimit[] = [
  {
    id: "client-alias-is-not-resolved",
    heading: "**A client alias is not resolved.**",
    fixture: ["const d = db;", "await d.room.create({ data: {} });"],
    // Neither arm: the alias binding is `db` without a delegate, and
    // `findRouteDbAccess` requires a member access after the dot.
    modelAxis: [],
    routeAccess: [],
  },
  {
    id: "routes-are-on-the-model-axis",
    heading: "**Routes are on the model axis.**",
    fixture: ["await tx.room.create({ data: {} });", "await prisma.room.create({ data: {} });"],
    // The reach bought, stated so a narrowing is red. Both are `Room`, which
    // `app/domains/rooms` owns, so a real one of these in a route is a crossing.
    modelAxis: ["Room", "Room"],
    // The one row that pins the pairing and not just the models: a
    // detector that reported `Room` from the wrong two lines would satisfy
    // `modelAxis` alone, and this is what makes it red.
    modelAxisLines: [
      [1, "Room"],
      [2, "Room"],
    ],
    routeAccess: [],
  },
  // --- the ten spellings, and the two arms that must stay unseen -----
  // Each row is a SCOPE arm: the fixture goes through the real scanner, so a
  // narrowing of the scanner turns this loop red. No named `it()` twin exists
  // for any of them — a second witness would multiply every mutation's red count
  // and the generic loop below is the single witness by construction.
  // That holds for **every** row above, items 4 and 5 included, and
  // the loop's coverage of them is asserted rather than assumed.
  {
    id: "chain-broken-across-lines",
    heading: "**A member chain broken across lines is seen.**",
    fixture: ["const c = tx.campus;", "await c", "  .create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "delegate-and-verb-split-across-lines",
    heading: "**A delegate and its verb split across lines are seen.**",
    fixture: ["await tx.campus.", "  create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "non-null-assertion-on-root",
    heading: "**`tx!` is seen.**",
    fixture: ["await tx!.campus.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "bracket-quoted-delegate",
    heading: '**`tx["campus"]` is seen.**',
    fixture: ['await tx["campus"].create({ data: {} });'],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "typeof-annotation-binds",
    heading: "**A `typeof` annotation still binds the alias.**",
    fixture: ["const c: typeof tx.campus = tx.campus;", "await c.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "as-cast-binds",
    heading: "**An `as` cast still binds the alias.**",
    fixture: ["const c = tx.campus as Campus;", "await c.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "destructured-delegate-binds",
    heading: "**A destructured delegate binds.**",
    fixture: ["const { campus } = tx;", "await campus.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "declaration-and-assignment-bind-as-one",
    heading: "**A `let` and its later assignment bind as one alias.**",
    fixture: ["let c;", "c = tx.campus;", "await c.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "binding-split-across-lines",
    heading: "**A binding split across lines binds.**",
    fixture: ["const c = tx", "  .campus;", "await c.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  {
    id: "bare-assignment-binds",
    heading: "**A bare assignment binds.**",
    fixture: ["c = tx.campus;", "await c.create({ data: {} });"],
    modelAxis: ["Campus"],
    routeAccess: [],
  },
  // The two arms from the other direction. The positive controls already saw
  // both stay unseen, so these are pins against a scanner that gained reach and
  // quietly started seeing reads and unknown delegates.
  {
    id: "read-verb-is-not-a-write",
    heading: "**A read verb is not a write.**",
    fixture: ["await tx.campus.findFirst({ where: {} });"],
    // `findFirst` is not in `WRITE_VERBS`. It is also not excluded by shape:
    // the verb list is the only thing standing between this row and a site.
    modelAxis: [],
    routeAccess: [],
  },
  {
    id: "unknown-delegate-is-not-a-delegate",
    heading: "**A delegate that resolves to no model is not a delegate.**",
    fixture: ["await tx.not_a_model.create({ data: {} });"],
    // The delegate resolves against the schema index, so this can only become a
    // site if a model of that name is added — which is the point.
    modelAxis: [],
    routeAccess: [],
  },
  {
    id: "consecutive-route-db-lines",
    heading: "**Two consecutive `db.` lines are both seen.**",
    fixture: ["await db.ticket.findMany({});", "await db.ticket.findMany({});"],
    // a shared `/g` regex reports line 1 and then skips line 2, because
    // `.test()` resumes from `lastIndex` left by the previous line's match.
    modelAxis: [],
    routeAccess: [1, 2],
  },
];

/**
 * The loop, as a function so its coverage can be asserted without depending on
 * another test having run first. It returns **the ids it asserted**, and
 * that return value is the instrument: two hand-written twins once existed whose
 * deletion changed nothing, because the loop already re-derived them and nothing
 * checked that the loop still reaches every row. Both twins are gone; this is now
 * the single witness for every declared limit, and its reach is asserted below.
 */
function assertEveryDeclaredLimit(): string[] {
  // The header's own closing JSDoc. Reading it back is what makes the prose a
  // claim rather than a comment: a limit declared here and absent there fails.
  const header = readFileSync(join(REPO, "test/cross-folder-writes.test.ts"), "utf8").split(
    "*/",
  )[0]!;
  const covered: string[] = [];
  for (const limit of DECLARED_LIMITS) {
    covered.push(limit.id);
    expect(header, `${limit.id} is not published in the header`).toContain(limit.heading);
    const scan = scanProdSource(blankComments(limit.fixture.join("\n")), ROUTE_FIXTURE_REL);
    expect(
      scan.sites.map((s) => s.model),
      `${limit.id} — model axis`,
    ).toEqual([...limit.modelAxis]);
    expect(
      scan.routeAccess.map((a) => a.line),
      `${limit.id} — routes arm`,
    ).toEqual([...limit.routeAccess]);
    // The `[line, model]` pairing, for the one row that declares it. `undefined` is
    // not `[]`: a row that pins no pairing asserts nothing here rather than
    // asserting an empty one, which is what keeps a dropped field red.
    if (limit.modelAxisLines !== undefined) {
      expect(
        scan.sites.map((s) => [s.line, s.model]),
        `${limit.id} — model axis lines`,
      ).toEqual(limit.modelAxisLines.map((pair) => [...pair]));
    }
  }
  return covered;
}

/** model → owning folder key, or `null` when the map records no owner. */
const OWNER = new Map<string, string | null>();
for (const [folder, models] of Object.entries(FOLDERS)) {
  for (const model of models) OWNER.set(model, folder);
}
for (const model of UNOWNED_MODELS) OWNER.set(model, null);

const EXEMPT_FILES = new Set(MODEL_AXIS_EXEMPTIONS.map((e) => e.file));
const ROUTE_EXEMPT_FILES = new Set(ROUTE_EXEMPTIONS.map((e) => e.file));

/**
 * The verdict, as a pure function so a probe can exercise it without a mutation.
 * `owner === null` and `scope === null` are both crossings: nobody owns the
 * model, or nothing claims the file.
 */
function isCrossing(file: string, model: string): boolean {
  const owner = OWNER.get(model);
  if (owner === undefined) return false;
  const scope = scopeOf(file);
  return owner !== scope;
}

function isViolation(file: string, model: string): boolean {
  return isCrossing(file, model) && !EXEMPT_FILES.has(file);
}

const GDPR_FILE = "app/domains/auth/gdpr.server.ts";

/** The two sanctioned crossings in the erasure path, named by their statement text. */
const GDPR_CROSSINGS: readonly (readonly [string, string, string])[] = [
  [
    "await tx.ticket.updateMany({ where: { reporterId: userId }, data: { reporterId: null } });",
    "Ticket",
    "updateMany",
  ],
  [
    "await tx.attachment.updateMany({ where: { createdById: userId }, data: { createdById: null } });",
    "Attachment",
    "updateMany",
  ],
];

/** The trimmed source line a site starts on — a locator that survives comment edits above it. */
function statementAt(site: WriteSite): string {
  return readFileSync(join(REPO, site.file), "utf8").split(/\r?\n/)[site.line - 1]!.trim();
}

/** Every site that crosses an ownership boundary, exempt or not. */
const CROSSINGS = SITES.filter((s) => isCrossing(s.file, s.model));
/** Crossings left after the named exemptions. This must be empty. */
const VIOLATIONS = CROSSINGS.filter((s) => !EXEMPT_FILES.has(s.file));
const CROSSINGS_IN_DOMAINS = CROSSINGS.filter((s) => s.file.startsWith("app/domains/"));
const UNCLAIMED_WRITES = CROSSINGS.filter((s) => scopeOf(s.file) === null);
const UNOWNED_WRITES = SITES.filter((s) => OWNER.get(s.model) === null);
const UNEXEMPTED_ROUTES = ROUTE_ACCESS.filter((a) => !ROUTE_EXEMPT_FILES.has(a.file));

describe("the folder map is complete and explicit", () => {
  it("accounts for every model in the schema, exactly once, with no silent key", () => {
    const accounted = new Set([...OWNER.keys()]);
    expect(MODELS.filter((m) => !accounted.has(m))).toEqual([]);
    expect(accounted.size).toBe(MODELS.length);
  });

  it("gives the unowned models an explicit null rather than an absent key", () => {
    for (const model of UNOWNED_MODELS) expect(OWNER.get(model)).toBeNull();
    expect(new Set(UNOWNED_MODELS).size).toBe(UNOWNED_MODELS.length);
    // Every unowned entry is a real model — a typo here is a silently-exempt one.
    expect(UNOWNED_MODELS.filter((m) => !MODELS.includes(m))).toEqual([]);
  });

  it("assigns each model to at most one folder", () => {
    const seen = new Map<string, string>();
    for (const [folder, models] of Object.entries(FOLDERS)) {
      for (const model of models) {
        expect(seen.has(model), `${model} is claimed by ${seen.get(model)} and ${folder}`).toBe(
          false,
        );
        seen.set(model, folder);
      }
    }
  });

  it("names every folder that holds a write — a writer outside the map is a finding, not a skip", () => {
    const writingScopes = new Set(SITES.map((s) => scopeOf(s.file)));
    expect([...writingScopes].filter((k) => k === null)).toEqual([]);
    expect([...writingScopes].filter((k) => !Object.keys(FOLDERS).includes(k!))).toEqual([]);
  });

  it("has a key that is a real directory", () => {
    for (const folder of Object.keys(FOLDERS)) {
      expect(statSync(join(REPO, folder)).isDirectory(), `${folder} is not a directory`).toBe(true);
    }
  });
});

describe("model axis: a write is performed by the folder that owns the model", () => {
  it("reports no cross-folder write outside the named exemptions", () => {
    expect(VIOLATIONS.map((s) => `${s.file}:${s.line} ${s.model}`)).toEqual([]);
  });

  it("blanks comments with TypeScript's scanner, so neither regex error can hide", () => {
    const src = [
      "/** Example: * const ticket = await tx.ticket.update({ data }); */",
      'const ROUTE = "/api/auth/*";',
      "await tx.ticket.update({ data: {} });",
    ].join("\n");
    expect(findWriteSites(blankComments(src), "fixture.ts", DELEGATES).map((s) => s.line)).toEqual([
      3,
    ]);
  });

  it("resolves a delegate alias — the arm with nothing to resolve in app/ today", () => {
    const src = [
      "const c = tx.campus;",
      "await c.create({ data: {} });",
      "await tx.room.update({ data: {} });",
    ].join("\n");
    expect(
      findWriteSites(blankComments(src), "fixture.ts", DELEGATES).map((s) => [s.model, s.viaAlias]),
    ).toEqual([
      ["Campus", true],
      ["Room", false],
    ]);
    // And the tree itself has no such binding — stated, so the first one is noticed.
    expect(SITES.filter((s) => s.viaAlias)).toEqual([]);
  });

  it("reports a bypass through an alias the same way as one through a delegate", () => {
    expect(isViolation("app/domains/rooms/rooms.mutations.server.ts", "Equipment")).toBe(true);
    expect(
      isViolation("app/domains/inventory/inventory.mutations.server.ts", "InventoryItem"),
    ).toBe(false);
  });
});

describe("the carve-out is one file, in app/domains", () => {
  it("allows exactly gdpr.server.ts there, by file", () => {
    expect(
      MODEL_AXIS_EXEMPTIONS.filter((e) => e.file.startsWith("app/domains/")).map((e) => e.file),
    ).toEqual(["app/domains/auth/gdpr.server.ts"]);
  });

  it("gives every exemption a reason — an unnamed exception is a silence", () => {
    for (const e of [...MODEL_AXIS_EXEMPTIONS, ...ROUTE_EXEMPTIONS]) {
      expect(e.reason.trim().length, `${e.file} has no reason`).toBeGreaterThan(20);
    }
  });

  it("does not exempt a file that needs no exemption", () => {
    // An unnecessary entry is the widening forbids: nothing removes it
    // once the repair that made it unnecessary has landed.
    for (const e of MODEL_AXIS_EXEMPTIONS) {
      const crossings = CROSSINGS.filter((s) => s.file === e.file);
      expect(crossings.length, `${e.file} is exempt but crosses nothing`).toBeGreaterThan(0);
    }
    for (const e of ROUTE_EXEMPTIONS) {
      expect(
        ROUTE_ACCESS.filter((a) => a.file === e.file).length,
        `${e.file} has no db. access`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers the sites named — one exempt file, two crossings", () => {
    // The erasure path detaches Ticket.reporterId and Attachment.createdBy. Both
    // crossings live in the same ONE exempt file, so the file-level carve-out
    // count is one — a third crossing, or one in any other file, is still a
    // violation. Sites are identified by their statement text, not by line
    // number, so a comment edit above them cannot break the test.
    const crossings = CROSSINGS.filter((s) => s.file === GDPR_FILE);
    expect(crossings.map((s) => [statementAt(s), s.model, s.verb])).toEqual(GDPR_CROSSINGS);
  });
});

describe("app/lib is inside the universe; its User writes are named", () => {
  it("sees the app/lib User writes, across exactly two files", () => {
    const libUserWrites = SITES.filter((s) => s.file.startsWith("app/lib/") && s.model === "User");
    expect([...new Set(libUserWrites.map((s) => s.file))].sort()).toEqual([
      "app/lib/auth-bootstrap.server.ts",
      "app/lib/auth.boot.server.ts",
    ]);
    expect(libUserWrites.length).toBeGreaterThan(1);
  });

  it("exempts exactly those two files, each carrying the audit-row known limitation", () => {
    const libExemptions = MODEL_AXIS_EXEMPTIONS.filter((e) => e.file.startsWith("app/lib/"));
    expect(libExemptions.map((e) => e.file).sort()).toEqual([
      "app/lib/auth-bootstrap.server.ts",
      "app/lib/auth.boot.server.ts",
    ]);
    for (const e of libExemptions) expect(e.reason).toContain("known limitation");
  });
});

describe("app/routes is scanned for direct db. access, read or write", () => {
  it("reports none outside the two named files", () => {
    expect(UNEXEMPTED_ROUTES.map((a) => `${a.file}:${a.line}`)).toEqual([]);
  });

  it("sees both the read and the raw-SQL probe — a writes-only rule would pass the read", () => {
    expect(
      findRouteDbAccess(
        "db.calendarOutbox.findFirst({});\ndb.$queryRaw`SELECT 1`;",
        "app/routes/probe/route.tsx",
      ).map((access) => access.line),
    ).toEqual([1, 2]);
    expect([...new Set(ROUTE_ACCESS.map((a) => a.file))].sort()).toEqual([
      "app/routes/healthz/route.tsx",
    ]);
  });

  it("exempts exactly those two files", () => {
    expect([...ROUTE_EXEMPT_FILES].sort()).toEqual(["app/routes/healthz/route.tsx"]);
  });

  // --- routes on the model axis, and the limits that survive it ---
  // The two hand-written twins were deleted: the alias one
  // re-derived the loop verbatim, and the route one held one assertion the loop
  // lacked — the `[line, model]` pairing — which is now the `modelAxisLines`
  // field, read and asserted by the loop below. The loop is the single witness.

  it("holds every declared limit to the detectors in use — widening and narrowing both red", () => {
    assertEveryDeclaredLimit();
  });

  it("covers every declared limit and nothing else — narrowing and widening both red", () => {
    // Deleting those twins left a suite that could not tell you a limit had
    // stopped being asserted: removing them *and* narrowing the
    // loop left the file green. So the loop's own reach is asserted here,
    // against the row set it iterates.
    //
    // **Two-sided, and that is the whole point:**
    // fewer ids is a narrowed loop, more ids is a hand-typed one the rows do not
    // declare. A one-sided `has()` would be satisfied by deleting the loop.
    const covered = assertEveryDeclaredLimit();
    const declared = DECLARED_LIMITS.map((l) => l.id).sort();
    expect([...covered].sort(), "the loop's covered ids drifted from the declared row set").toEqual(
      declared,
    );
  });
});

describe("builder-bypass, on a census derived rather than typed", () => {
  it("sees a sanctioned cross-folder write as a call, not as a delegate write", () => {
    // the owner writes the code, the caller's tx carries the write.
    // rooms/ -> inventory/ and inventory/ -> catalog/ are the only two, and
    // neither contains `tx.<foreignModel>.<verb>(` — so neither is a bypass.
    for (const caller of [
      "app/domains/rooms/rooms.mutations.server.ts",
      "app/domains/inventory/inventory.mutations.server.ts",
    ]) {
      const foreign = SITES.filter((s) => s.file === caller && isViolation(caller, s.model));
      expect(
        foreign.map((s) => `${s.line} ${s.model}`),
        `${caller} writes another folder's model`,
      ).toEqual([]);
    }
  });

  it("still reports the builder-bypass shape, which is the probe's own shape", () => {
    expect(isViolation("app/domains/rooms/rooms.mutations.server.ts", "Equipment")).toBe(true);
    expect(
      isViolation("app/domains/inventory/inventory.mutations.server.ts", "EquipmentModel"),
    ).toBe(true);
    expect(isViolation("app/domains/inventory/inventory.mutations.server.ts", "Equipment")).toBe(
      false,
    );
  });

  it("resolves every site to a model the map knows", () => {
    expect(SITES.filter((s) => !OWNER.has(s.model))).toEqual([]);
  });

  it("keeps the unowned models at zero writes — the hole a future writer would fill", () => {
    expect(UNOWNED_WRITES.map((s) => `${s.file}:${s.line} ${s.model}`)).toEqual([]);
  });
});

describe("green on the tree as it stands", () => {
  it("finds exactly the one carve-out file — two named crossings — and nothing else under app/domains", () => {
    expect(CROSSINGS_IN_DOMAINS.map((s) => `${s.file} ${s.model} ${statementAt(s)}`)).toEqual(
      GDPR_CROSSINGS.map(([statement, model]) => `${GDPR_FILE} ${model} ${statement}`),
    );
  });

  it("finds no crossing at all outside the three named exemptions", () => {
    expect(VIOLATIONS).toEqual([]);
  });

  it("finds no write at all from a file no folder claims", () => {
    expect(UNCLAIMED_WRITES).toEqual([]);
  });
});

describe("the scanned file set is asserted, not assumed", () => {
  it("names the files it did not read, and each has a reason", () => {
    const unread = ALL_PROD.filter((rel) => !READ_FILES.has(rel));
    const roots = Object.keys(UNSCANNED_ROOTS);
    expect([
      ...new Set(unread.map((rel) => roots.find((r) => rel.startsWith(`${r}/`)) ?? "(unclaimed)")),
    ]).toEqual(roots);
    for (const root of roots) expect(UNSCANNED_ROOTS[root]!.length).toBeGreaterThan(20);
  });

  it("reads every prod file outside the declared roots", () => {
    expect([...READ_FILES].sort()).toEqual([...SCANNED_PROD].sort());
  });

  it("scans exactly the file set the map names — derived, not assumed", () => {
    // Derivation A: whole-app walk, bucketed. Derivation B: walk each key.
    const bucketed = new Set(SCANNED_PROD.filter((rel) => scopeOf(rel) !== null));
    const perKey = new Set(
      [...Object.keys(FOLDERS), ROUTE_SCOPE].flatMap((scope) =>
        walkProd(join(REPO, scope)).map(toRepoPath).filter(isProdSource),
      ),
    );
    expect([...bucketed].sort()).toEqual([...perKey].sort());
  });

  it("opens every file that holds a CalendarOutbox write — the subdirectory a shallow read of app/lib misses", () => {
    const owners = [
      ...new Set(SITES.filter((s) => s.model === "CalendarOutbox").map((s) => s.file)),
    ].sort();
    expect(owners).toEqual([
      "app/lib/calendar/initial-publication.server.ts",
      "app/lib/calendar/outbox.server.ts",
      "app/lib/calendar/publisher.server.ts",
    ]);
    expect(owners.every((f) => READ_FILES.has(f))).toBe(true);
    expect(OWNER.get("CalendarOutbox")).toBe("app/lib/calendar");
  });

  it("and the walk itself is pinned recursive — the direction that adds", () => {
    // A removal-only reach control cannot fail on tomorrow's fifth folder, and
    // rot was a *missing* folder. So this runs in the adding direction
    // against a scratch tree: a new file must change the walked set.
    const scratch = mkdtempSync(join(tmpdir(), "jiangtang-reach-"));
    try {
      expect(walkProd(scratch)).toEqual([]);
      writeFileSync(join(scratch, "top.ts"), "export const a = 1;\n");
      expect(walkProd(scratch).length).toBe(1);
      mkdirSync(join(scratch, "sub"));
      writeFileSync(join(scratch, "sub", "nested.ts"), "export const b = 2;\n");
      expect(walkProd(scratch).length).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
