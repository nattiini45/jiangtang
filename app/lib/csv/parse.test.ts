import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvToObjects } from "./parse";

describe("parseCsv (RFC 4180)", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv('name,note\n"Hörsaal 32, D11","a, b, c"')).toEqual([
      ["name", "note"],
      ["Hörsaal 32, D11", "a, b, c"],
    ]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([["a"], ['she said "hi"']]);
  });

  it("treats CRLF and LF the same and ignores a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("﻿a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves ragged rows verbatim (no padding at this layer)", () => {
    expect(parseCsv("a,b,c\n1,2\n3,4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["3", "4", "5", "6"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });
});

describe("parseCsvToObjects", () => {
  it("maps rows onto trimmed headers", () => {
    const { headers, rows } = parseCsvToObjects("name , roomNumber\n Hörsaal 32 , D.11.23 ");
    expect(headers).toEqual(["name", "roomNumber"]);
    expect(rows).toEqual([{ name: "Hörsaal 32", roomNumber: "D.11.23" }]);
  });

  it("pads missing trailing cells to the header width", () => {
    const { rows } = parseCsvToObjects("a,b,c\n1,2");
    expect(rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("truncates extra cells beyond the header width", () => {
    const { rows } = parseCsvToObjects("a,b\n1,2,3");
    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("skips fully blank lines", () => {
    const { rows } = parseCsvToObjects("a,b\n1,2\n\n3,4");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("returns empty headers/rows for empty input", () => {
    expect(parseCsvToObjects("")).toEqual({ headers: [], rows: [] });
  });

  it("does not pollute Object.prototype via a __proto__ header", () => {
    const { rows } = parseCsvToObjects("__proto__,name\nEVIL,Hörsaal 32");
    // The row itself must carry the value as an own property, not mutate the prototype.
    expect(Object.prototype.hasOwnProperty.call(rows[0], "__proto__")).toBe(true);
    expect(rows[0].__proto__).toBe("EVIL");
    expect(rows[0].name).toBe("Hörsaal 32");
    // No global pollution leaked onto a fresh plain object.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
