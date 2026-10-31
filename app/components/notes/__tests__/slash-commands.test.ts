import { describe, expect, it } from "vitest";
import {
  applySlashCommand,
  filterSlashCommands,
  slashQuery,
  SLASH_COMMANDS,
} from "~/components/notes/slash-commands";

/**
 * The `/`-command row's pure contract: when it opens, what it filters,
 * and exactly where the caret lands after an insertion.
 */
describe("slashQuery", () => {
  it("opens on `/` at the start of a line and reads the query", () => {
    expect(slashQuery("/ta", 3)).toEqual({ lineStart: 0, query: "ta" });
    expect(slashQuery("erste zeile\n/ta", 15)).toEqual({ lineStart: 12, query: "ta" });
  });

  it("does not open mid-line, after a space, or at position 0", () => {
    expect(slashQuery("x/ta", 4)).toBeNull();
    expect(slashQuery("/ ta", 4)).toBeNull();
    expect(slashQuery("text", 0)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns everything on an empty query", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("matches German labels case-insensitively and ids by prefix", () => {
    expect(filterSlashCommands("über").map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterSlashCommands("ta").map((c) => c.id)).toEqual(
      expect.arrayContaining(["table", "quote"]),
    );
    expect(filterSlashCommands("zzz")).toEqual([]);
  });
});

describe("applySlashCommand", () => {
  it("replaces the /query fragment and lands the caret after the snippet", () => {
    const h1 = SLASH_COMMANDS.find((c) => c.id === "h1")!;
    const out = applySlashCommand("vor\n/h1\nnach", 7, h1);
    expect(out).toEqual({ text: "vor\n# \nnach", cursor: 6 });
  });

  it("lands the caret INSIDE a code block skeleton", () => {
    const code = SLASH_COMMANDS.find((c) => c.id === "code")!;
    const out = applySlashCommand("/co", 3, code)!;
    expect(out.text).toBe("```\n\n```\n");
    expect(out.text[out.cursor - 1]).toBe("\n"); // inside the fence
    expect(out.cursor).toBe(4);
  });

  it("drops the query text entirely — /tabelle becomes the table, not /tabelle+table", () => {
    const table = SLASH_COMMANDS.find((c) => c.id === "table")!;
    const out = applySlashCommand("/tabelle", 8, table)!;
    expect(out.text).not.toContain("/tabelle");
    expect(out.text).toContain("| --- |");
  });

  it("returns null when the cursor is not in a /query", () => {
    const h1 = SLASH_COMMANDS.find((c) => c.id === "h1")!;
    expect(applySlashCommand("plain text", 5, h1)).toBeNull();
  });
});
