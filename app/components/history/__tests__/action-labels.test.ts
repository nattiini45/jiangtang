import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { messages } from "~/i18n";
import { LOCALES } from "~/i18n/locales";
import { actionLabel } from "../labels";

/**
 * The no-unlabelled-verb guard: every audit `action` literal written
 * under `app/domains/` must have a label in every language catalog, so a new
 * verb cannot ship rendering as its raw enum-ish key in the activity feed.
 *
 * The scan is deliberately simple — a domain that starts constructing action
 * names dynamically (e.g. `action: \`Ticket${x}\``) escapes it on purpose:
 * there is nothing static to label. The day that happens, this test and the
 * label map need a different contract, not a cleverer regex.
 */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith(".server.ts")) yield path;
  }
}

/** Every string literal inside an `action:` expression — plain and ternary.
 *  The capture stops at the first `,`/`;`/newline so the `entityType:` literal
 *  that follows on the same line is not mistaken for a verb. */
export function auditActionLiterals(source: string): string[] {
  const verbs = new Set<string>();
  for (const m of source.matchAll(/action:\s*([^;,\n]+)/g)) {
    for (const lit of m[1].matchAll(/["'`]([A-Za-z][A-Za-z0-9]*)["'`]/g)) verbs.add(lit[1]);
  }
  return [...verbs];
}

describe("history action label coverage", () => {
  it("labels every audit action literal written under app/domains/", () => {
    const verbs = new Set<string>();
    for (const file of walk(join(process.cwd(), "app", "domains"))) {
      for (const verb of auditActionLiterals(readFileSync(file, "utf8"))) verbs.add(verb);
    }
    for (const locale of LOCALES) {
      const catalog = messages(locale) as Record<string, string>;
      const missing = [...verbs].filter((v) => !(`history.action.${v}` in catalog));
      expect(missing, locale).toEqual([]);
    }
  });

  it("labels every demo-seed audit verb (built as Demo<Label>Seeded)", () => {
    const seed = readFileSync(join(process.cwd(), "scripts", "seed", "workspace-seed.ts"), "utf8");
    const verbs = [...seed.matchAll(/\bnote\(\s*"([A-Za-z]+)"/g)].map((m) => `Demo${m[1]}Seeded`);
    expect(verbs).toContain("DemoTimeEntrySeeded");
    for (const locale of LOCALES) {
      const catalog = messages(locale) as Record<string, string>;
      expect(
        verbs.filter((v) => !(`history.action.${v}` in catalog)),
        locale,
      ).toEqual([]);
    }
    expect(actionLabel("de", "DemoTimeEntrySeeded")).toBe("Per Demo-Seed angelegt");
    expect(actionLabel("en", "DemoTimeEntrySeeded")).toBe("Created by demo seed");
  });

  it("renders a label per language and falls back to the raw action name", () => {
    expect(actionLabel("de", "TaskCreated")).toBe("Erstellt");
    expect(actionLabel("en", "TaskStatusChanged")).toBe("Status changed");
    expect(actionLabel("en", "SomethingNew")).toBe("SomethingNew");
  });

  it("extracts literals from plain, ternary and variable-free expressions", () => {
    const src = [
      `audit({ action: "TaskCreated", entityType: "task" })`,
      `action: resolved ? "TicketResolved" : "TicketCreated",`,
      `action: verb, // a variable — nothing static to label`,
    ].join("\n");
    expect(auditActionLiterals(src).sort()).toEqual([
      "TaskCreated",
      "TicketCreated",
      "TicketResolved",
    ]);
  });
});
