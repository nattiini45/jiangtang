import { describe, expect, it } from "vitest";
import { messages, t, type MessageKey } from "~/i18n";
import { LOCALES } from "~/i18n/locales";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalog parity", () => {
  const de = messages("de");
  const en = messages("en");

  it("has identical key sets in both languages", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });

  it("has no empty or whitespace-only message in any language", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(messages(locale))) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("uses the same {placeholders} in both languages", () => {
    for (const key of Object.keys(de) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(de[key]));
    }
  });
});

describe("t()", () => {
  it("returns the message of the requested locale", () => {
    expect(t("de", "status.task.IN_PROGRESS")).toBe("In Arbeit");
    expect(t("en", "status.task.IN_PROGRESS")).toBe("In progress");
  });

  it("interpolates {name} placeholders, numbers included", () => {
    expect(t("de", "notes.editor.savedAt", { time: "14:05" })).toBe("Gespeichert 14:05");
    expect(t("en", "notes.editor.savedAt", { time: "14:05" })).toBe("Saved 14:05");
    expect(t("en", "tasks.import.description", { statuses: "A", priorities: 3 })).toContain(
      "Status: A. Priority: 3.",
    );
  });

  it("leaves a placeholder visible when its parameter is missing", () => {
    expect(t("en", "notes.editor.savedAt")).toBe("Saved {time}");
    expect(t("en", "notes.editor.savedAt", { other: "x" })).toBe("Saved {time}");
  });

  it("returns the key itself for an unknown key instead of throwing", () => {
    expect(t("en", "no.such.key" as MessageKey)).toBe("no.such.key");
    expect(t("de", "no.such.key" as MessageKey, { a: 1 })).toBe("no.such.key");
  });
});
