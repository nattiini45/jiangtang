import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveShadowUrl } from "../prisma.config";

/**
 * CI GUARD.
 *
 * Two rules, both scoped to what is new relative to the baseline schema:
 *   1. every new `DateTime` carries `@db.Timestamptz(3)`;
 *   2. every NEW relation carries an explicit `onDelete` on its owning side.
 *
 * The scope is deliberately wider than "the new model blocks": the rule is
 * scoped to *"a **new relation** without one does not pass review"*, and two of
 * the newer relations live inside EXISTING blocks — `Event.projectId` and
 * `Ticket.taskId`. A guard that only reads the new blocks is blind to exactly
 * the class the rule exists for, which is what the negative control below pins.
 *
 * What this does NOT do, on purpose: re-implement `prisma validate`. A
 * back-reference carrying `onDelete` is already `P1012`, so the tool owns that
 * half. This guard exists for the half no tool checks — a *correct* schema that
 * quietly omits a referential action.
 *
 * Every rule here has a NEGATIVE CONTROL that asserts the checker goes red on
 * the broken input. A guard with no control is a comment that costs a parse.
 */

const SCHEMA_PATH = resolve(process.cwd(), "prisma/schema.prisma");

/** The seven new models plus the explicit assignee join. */
const NEW_BLOCKS = [
  "Location",
  "Project",
  "TaskAssignees",
  "Task",
  "TaskDependency",
  "Note",
  "InventoryItem",
  "Vendor",
  "PersonalAccessToken",
  "UserPermission",
  "Invitation",
] as const;

/**
 * New relations that live inside blocks the newer models did not add. Keyed by model, valued
 * by the FK scalar's field name — because in Prisma the referential action sits
 * on the *relation* field (`project Project? @relation(...)`), not on the
 * scalar. Resolving scalar -> owning field is the only way to scope correctly.
 */
const NEW_RELATIONS_IN_EXISTING_BLOCKS: Record<string, string[]> = {
  Event: ["projectId"],
  Ticket: ["taskId"],
};

type Field = { name: string; attrs: string };
type Block = { name: string; fields: Field[] };

/** Strip `//` and block comments so a commented-out field cannot satisfy a rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Split a model body into fields, respecting nested (), [] and {}. */
function parseFields(body: string): Field[] {
  const fields: Field[] = [];
  let depth = 0;
  let buf = "";
  const flush = () => {
    const text = buf.trim();
    buf = "";
    // `@@index(...)` / `@@unique(...)` are block attributes, not fields: they
    // start with `@` and the name pattern below correctly refuses them.
    const m = text.match(/^(\w+)\s+([\s\S]+)$/);
    if (m) fields.push({ name: m[1], attrs: m[2] });
  };
  for (const ch of body) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "\n" && depth <= 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return fields;
}

function parseBlocks(src: string): Block[] {
  const clean = stripComments(src);
  const blocks: Block[] = [];
  const re = /model\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < clean.length && depth > 0) {
      const ch = clean[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    blocks.push({ name, fields: parseFields(clean.slice(start, i - 1)) });
  }
  return blocks;
}

/** The owning side of a relation is the field carrying `fields: [..]`. */
function isOwningSide(f: Field): boolean {
  return /\bfields:\s*\[/.test(f.attrs);
}

/** Resolve the FK scalar to the relation field that owns it. */
function ownerOf(block: Block, fkName: string): Field | undefined {
  return block.fields.find((f) => isOwningSide(f) && f.attrs.includes(`[${fkName}]`));
}

function isDateTimeField(f: Field): boolean {
  return /^DateTime\??\b/.test(f.attrs.trim());
}

type Violation = { rule: string; where: string; detail: string };

/**
 * Run both rules over a schema string and return every violation.
 *
 * A missing block is itself a violation: if the newer models were renamed, a scope
 * list that silently matched nothing would report a clean sweep — the failure
 * mode a text-scanning guard is structurally unable to notice.
 */
function checkSchema(src: string): Violation[] {
  const blocks = parseBlocks(src);
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const out: Violation[] = [];

  for (const name of NEW_BLOCKS) {
    const block = byName.get(name);
    if (!block) {
      out.push({ rule: "scope", where: name, detail: "model block not found" });
      continue;
    }
    if (block.fields.length === 0) {
      out.push({ rule: "scope", where: name, detail: "model block parsed to zero fields" });
    }
    for (const f of block.fields) {
      if (isDateTimeField(f) && !f.attrs.includes("@db.Timestamptz(3)")) {
        out.push({
          rule: "timestamptz",
          where: `${name}.${f.name}`,
          detail: "DateTime without @db.Timestamptz(3)",
        });
      }
      if (isOwningSide(f) && !/\bonDelete:/.test(f.attrs)) {
        out.push({
          rule: "onDelete",
          where: `${name}.${f.name}`,
          detail: "owning-side relation without onDelete",
        });
      }
    }
  }

  for (const [model, fks] of Object.entries(NEW_RELATIONS_IN_EXISTING_BLOCKS)) {
    const block = byName.get(model);
    if (!block) {
      out.push({ rule: "scope", where: model, detail: "existing block not found" });
      continue;
    }
    for (const fk of fks) {
      if (!block.fields.some((f) => f.name === fk)) {
        out.push({
          rule: "scope",
          where: `${model}.${fk}`,
          detail: "expected FK scalar not found",
        });
        continue;
      }
      const owner = ownerOf(block, fk);
      if (!owner) {
        out.push({
          rule: "scope",
          where: `${model}.${fk}`,
          detail: "no owning-side relation references this FK",
        });
        continue;
      }
      if (!/\bonDelete:/.test(owner.attrs)) {
        out.push({
          rule: "onDelete",
          where: `${model}.${fk}`,
          detail: `owning relation \`${owner.name}\` has no onDelete`,
        });
      }
    }
  }

  return out;
}

const SCHEMA = readFileSync(SCHEMA_PATH, "utf8");

/**
 * Replace text INSIDE one named model block.
 *
 * Deliberately not a global `String.replace`: `Event.project` and `Task.project`
 * carry byte-identical attribute text, so "remove the first onDelete" would edit
 * whichever the parser reached first and the control would pass without ever
 * exercising the field it names. A negative control that cannot be pointed at
 * its target is not a control.
 */
function mutateInModel(src: string, model: string, from: string, to: string): string {
  const start = src.search(new RegExp(`model\\s+${model}\\s*\\{`));
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const bodyStart = src.indexOf("{", start) + 1;
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const body = src.slice(bodyStart, i - 1);
  const at = body.indexOf(from);
  expect(at, `needle not found in ${model}: ${from}`).toBeGreaterThan(-1);
  return (
    src.slice(0, bodyStart) +
    body.slice(0, at) +
    to +
    body.slice(at + from.length) +
    src.slice(i - 1)
  );
}

function violationsIn(src: string, rule: string): string[] {
  return checkSchema(src)
    .filter((v) => v.rule === rule)
    .map((v) => v.where);
}

describe("schema guard", () => {
  it("finds every block in scope — the guard can see what it claims to check", () => {
    // A scope list that matched nothing would make every assertion below pass
    // for the wrong reason. Assert the instrument before trusting its output.
    const byName = new Map(parseBlocks(SCHEMA).map((b) => [b.name, b]));
    for (const name of NEW_BLOCKS) {
      const block = byName.get(name);
      expect(block, `${name} must exist in the schema`).toBeDefined();
      expect(block!.fields.length, `${name} must have fields`).toBeGreaterThan(0);
    }
    for (const [model, fks] of Object.entries(NEW_RELATIONS_IN_EXISTING_BLOCKS)) {
      const block = byName.get(model)!;
      expect(block, `${model} must exist in the schema`).toBeDefined();
      for (const fk of fks) {
        expect(ownerOf(block, fk), `${model}.${fk} must have an owning relation`).toBeDefined();
      }
    }
  });

  it("gives the committed schema a clean sweep", () => {
    expect(checkSchema(SCHEMA)).toEqual([]);
  });

  it("catches a new relation with no onDelete inside an EXISTING block", () => {
    // The negative control the old scope could not produce: Event.projectId
    // lives in a block that predates the change, and it is the class names.
    const broken = mutateInModel(
      SCHEMA,
      "Event",
      "@relation(fields: [projectId], references: [id], onDelete: SetNull)",
      "@relation(fields: [projectId], references: [id])",
    );
    expect(violationsIn(broken, "onDelete")).toContain("Event.projectId");
  });

  it("catches a new relation with no onDelete inside a new block", () => {
    // Control for the second half of the scope: TaskDependency.blockedBy is
    // Cascade, and the composite-key block has no owning field called `taskId`.
    const broken = mutateInModel(
      SCHEMA,
      "TaskDependency",
      "fields: [blockedByTaskId], references: [id], onDelete: Cascade)",
      "fields: [blockedByTaskId], references: [id])",
    );
    expect(violationsIn(broken, "onDelete")).toContain("TaskDependency.blockedBy");
  });

  it("catches a new DateTime with no @db.Timestamptz(3)", () => {
    const broken = mutateInModel(
      SCHEMA,
      "Task",
      "dueAt            DateTime? @db.Timestamptz(3)",
      "dueAt            DateTime?",
    );
    expect(violationsIn(broken, "timestamptz")).toContain("Task.dueAt");
  });

  it("is not satisfied by a back-reference carrying onDelete", () => {
    // A back-reference may not take onDelete at all — `prisma validate` rejects
    // it (P1012). Proving the checker keys on `fields:`, not on the word
    // `onDelete` appearing anywhere in a block, keeps the two halves honest.
    let broken = mutateInModel(
      SCHEMA,
      "TaskDependency",
      "fields: [blockedByTaskId], references: [id], onDelete: Cascade)",
      "fields: [blockedByTaskId], references: [id])",
    );
    broken = mutateInModel(
      broken,
      "TaskDependency",
      'blocking        Task @relation("TaskBlocking"',
      'blocking        Task @relation("TaskBlocking") onDelete: Cascade; // @relation("TaskBlocking"',
    );
    // The owning side is still the one reported: the planted word on the
    // back-reference bought nothing.
    expect(violationsIn(broken, "onDelete")).toContain("TaskDependency.blockedBy");
  });

  it("reports a renamed block as a scope failure rather than a clean sweep", () => {
    // The instrument must be able to say "I cannot see this".
    const renamed = SCHEMA.replace(/\bmodel Note \{/, "model WorkspaceNote {");
    const found = checkSchema(renamed);
    expect(found.some((v) => v.rule === "scope" && v.where === "Note")).toBe(true);
  });

  it("adds 25 owning-side relations, counts the +1, and leaves the 12 pre-existing omissions untouched", () => {
    // Counted by this test, so drift surfaces as a number rather than as a quiet widening of
    // what the guard silently skips. The baseline had 22 owning-side relations, 10 carrying
    // onDelete and 12 omitting it. Those 12 are the baseline's and are not part of this change.
    // The newer models add 25, all carrying an action, so the omissions must not move. TimeEntry
    // later added its taskId/userId/createdById (3), and the later Attachment.createdBy relation,
    // the +1 counted here, carries `onDelete: SetNull`, so BOTH counters rise by one and the 12
    // pre-existing omissions are unchanged (the new relation is not an omission).
    const blocks = parseBlocks(SCHEMA);
    let owning = 0;
    let withAction = 0;
    for (const b of blocks) {
      for (const f of b.fields) {
        if (!isOwningSide(f)) continue;
        owning++;
        if (/\bonDelete:/.test(f.attrs)) withAction++;
      }
    }
    expect(owning).toBe(56);
    expect(withAction).toBe(44);
    expect(owning - withAction).toBe(12); // unchanged pre-existing baseline — the relation carries onDelete
  });
});

describe("shadow database url", () => {
  // The setting that guards against the landmine. The rule is not
  // "a shadow URL exists" but "it can never be the database `migrate dev` would
  // otherwise reset", so the equality case is the one that matters.
  const DEV = "postgresql://jiangtang:jiangtang@localhost:5432/jiangtang";

  it("never returns the database url it was given", () => {
    expect(deriveShadowUrl(DEV)).not.toBe(DEV);
  });

  it("keeps host, port and credentials, swapping only the database name", () => {
    const shadow = new URL(deriveShadowUrl(DEV)!);
    const dev = new URL(DEV);
    expect(shadow.host).toBe(dev.host);
    expect(shadow.username).toBe(dev.username);
    expect(shadow.password).toBe(dev.password);
    expect(shadow.pathname).not.toBe(dev.pathname);
    expect(shadow.pathname).toBe("/jiangtang_shadow");
  });

  it("preserves query parameters such as ?schema=public", () => {
    const shadow = deriveShadowUrl(`${DEV}?schema=public&connection_limit=1`);
    expect(shadow).toContain("schema=public");
    expect(shadow).toContain("connection_limit=1");
  });

  it("is undefined with no DATABASE_URL rather than a guess", () => {
    expect(deriveShadowUrl(undefined)).toBeUndefined();
  });

  it("is undefined for an unparseable url rather than a broken one", () => {
    expect(deriveShadowUrl("not a url")).toBeUndefined();
  });
});
