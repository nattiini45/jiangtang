import { describe, expect, it } from "vitest";
import { slashCommands } from "~/components/notes/slash-commands";
import { buildGantt } from "~/components/projects/gantt";
import { priorityOptions } from "~/components/tickets/labels";
import { messages } from "~/i18n";

describe("work-area labels follow the locale", () => {
  it("localizes the notes slash commands but not their markdown snippets", () => {
    const de = slashCommands("de");
    const en = slashCommands("en");
    expect(en.map((c) => c.insert)).toEqual(de.map((c) => c.insert));
    expect(en.map((c) => c.label)).not.toEqual(de.map((c) => c.label));
    expect(en.every((c) => c.label.length > 0 && !c.label.startsWith("notes."))).toBe(true);
  });

  it("composes the ticket priority options per locale", () => {
    expect(priorityOptions("de")[0]).toEqual({ value: 1, label: "1 · Hoch" });
    expect(priorityOptions("en")[0]).toEqual({ value: 1, label: "1 · High" });
  });

  it("labels Gantt weeks with the locale's week abbreviation", () => {
    const input = {
      tasks: [],
      projectStartAt: "2026-11-02",
      projectDueAt: "2026-11-20",
      today: new Date("2026-11-05T12:00:00Z"),
    };
    const de = buildGantt(input);
    const en = buildGantt({ ...input, locale: "en" });
    expect(de.weeks[0]?.label).toMatch(/^KW \d{2}$/);
    expect(en.weeks[0]?.label).toMatch(/^Wk \d{2}$/);
  });

  it("has no English message that equals its own key", () => {
    const en = messages("en");
    const leaked = Object.entries(en).filter(([key, value]) => key === value);
    expect(leaked).toEqual([]);
  });
});
