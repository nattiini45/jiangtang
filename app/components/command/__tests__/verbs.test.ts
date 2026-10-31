import { describe, expect, it } from "vitest";
import { NAV } from "~/components/layout/nav";
import { scoreVerb, verbsFor, verbsIn } from "~/components/command/verbs";
import { t } from "~/i18n";
import { LOCALES } from "~/i18n/locales";

const VERBS = verbsIn("de");

/**
 * The verb registry contract: unique ids, non-empty labels in both languages, one
 * Gehe-zu verb per nav entry, context verbs declaring their context, and
 * admin verbs hidden for members — the palette filters through `verbsFor`.
 */

describe("verb registry", () => {
  it("has unique ids", () => {
    const ids = VERBS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has non-empty labels and keyword lists in every language", () => {
    for (const locale of LOCALES) {
      for (const v of verbsIn(locale)) {
        expect(v.label.trim().length, `${locale} ${v.id}`).toBeGreaterThan(0);
        expect(/[A-ZÄÖÜ]/.test(v.label), `${locale} ${v.id}`).toBe(true);
        expect(v.keywords.length, `${locale} ${v.id}`).toBeGreaterThan(0);
        expect(v.group.trim().length, `${locale} ${v.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("renders labels and groups in the requested language", () => {
    const en = verbsIn("en");
    expect(en.find((v) => v.id === "new-task")?.label).toBe("Create task");
    expect(en.find((v) => v.id === "goto-tasks")?.label).toBe("Go to Tasks");
    expect(en.find((v) => v.id === "task-set-status-done")?.label).toBe("Set status: Done");
    expect(VERBS.find((v) => v.id === "new-task")?.label).toBe("Aufgabe anlegen");
    expect(VERBS.find((v) => v.id === "task-set-status-done")?.label).toBe(
      "Status setzen: Erledigt",
    );
  });

  it("lets the English palette match German and English words", () => {
    const goto = verbsIn("en").find((v) => v.id === "goto-tasks")!;
    expect(scoreVerb(goto, "tasks")).toBeGreaterThan(0);
    expect(scoreVerb(goto, "aufgaben")).toBeGreaterThan(0);
  });

  it("offers a Gehe-zu verb for every nav entry", () => {
    for (const entry of NAV) {
      const id = `goto-${entry.to.replaceAll("/", "") || "index"}`;
      const verb = VERBS.find((v) => v.id === id);
      expect(verb, entry.to).toBeDefined();
      expect(verb!.label).toBe(`Gehe zu ${t("de", entry.labelKey)}`);
      expect(verbsIn("en").find((v) => v.id === id)!.label).toBe(
        `Go to ${t("en", entry.labelKey)}`,
      );
      expect(Boolean(verb!.adminOnly), entry.to).toBe(Boolean(entry.adminOnly));
    }
  });

  it("marks admin-only nav verbs and the index verb adminOnly", () => {
    const adminVerbs = VERBS.filter((v) => v.adminOnly).map((v) => v.id);
    expect(adminVerbs).toContain("admin-index-reconcile");
    for (const entry of NAV.filter((e) => e.adminOnly)) {
      expect(adminVerbs).toContain(`goto-${entry.to.replaceAll("/", "")}`);
    }
  });

  it("keeps context verbs declared and task-only", () => {
    const contextual = VERBS.filter((v) => v.context !== undefined);
    expect(contextual.length).toBeGreaterThanOrEqual(9); // assign-me + 7 statuses + edit-title
    for (const v of contextual) expect(v.context, v.id).toBe("task");
    const ids = contextual.map((v) => v.id);
    expect(ids).toContain("task-assign-me");
    expect(ids).toContain("task-edit-title");
    expect(ids).toContain("task-set-status-in_progress");
    expect(ids).toContain("task-set-status-done");
  });

  it("verbsFor hides admin and context verbs for members", () => {
    const member = verbsFor({ admin: false, locale: "de" });
    expect(member.some((v) => v.adminOnly)).toBe(false);
    expect(member.some((v) => v.context !== undefined)).toBe(false);
    expect(member.some((v) => v.id === "new-task")).toBe(true);
  });

  it("verbsFor exposes admin verbs to admins and context verbs on task pages", () => {
    const admin = verbsFor({ admin: true, locale: "en" });
    expect(admin.some((v) => v.id === "admin-index-reconcile")).toBe(true);
    expect(admin.some((v) => v.context !== undefined)).toBe(false);
    const onTask = verbsFor({ admin: true, context: "task", locale: "de" });
    expect(onTask.some((v) => v.id === "task-assign-me")).toBe(true);
    expect(onTask.some((v) => v.id === "task-edit-title")).toBe(true);
  });
});

describe("scoreVerb", () => {
  const verb = VERBS.find((v) => v.id === "new-task")!;

  it("ranks exact label matches above subsequence matches", () => {
    const gotoTasks = VERBS.find((v) => v.id === "goto-tasks")!;
    expect(scoreVerb(verb, "aufgabe anlegen")).toBeGreaterThan(
      scoreVerb(gotoTasks, "aufgabe anlegen"),
    );
    expect(scoreVerb(gotoTasks, "aufgabe anlegen")).toBe(-1);
  });

  it("matches keywords and returns -1 on a miss", () => {
    expect(scoreVerb(verb, "neu")).toBeGreaterThan(0);
    expect(scoreVerb(verb, "xyzzy")).toBe(-1);
    expect(scoreVerb(verb, "")).toBe(1); // empty query lists every verb
  });
});
