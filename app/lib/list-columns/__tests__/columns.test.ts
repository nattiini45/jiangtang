import { describe, expect, it } from "vitest";
import { createTable, getCoreRowModel, getSortedRowModel } from "@tanstack/react-table";
import { withFieldColumns } from "~/components/data-grid/field-columns";
import {
  fieldSortValue,
  fieldText,
  resolveColumns,
  type ListField,
  type ListValue,
} from "../columns";

const field = (type: ListField["type"]): ListField => ({
  id: "property",
  name: "Property",
  type,
  unit: "h",
  kindNames: [],
  options: [
    { id: "first", label: "Zulu", archived: false },
    { id: "second", label: "Alpha", archived: false },
  ],
});

describe("typed list columns", () => {
  it("preserves the default name width and reserves readable names beside field columns", () => {
    const builtins = [{ accessorKey: "name", size: 142 }];
    expect(withFieldColumns(builtins, { columns: ["name"], fields: [] }, "de")[0].size).toBe(142);
    expect(
      withFieldColumns(
        builtins,
        { columns: ["name", "field:property"], fields: [field("TEXT")] },
        "de",
      )[0].size,
    ).toBe(220);
  });
  it.each<[ListField["type"], ListValue, ListValue]>([
    ["TEXT", "Ähre", "Zebra"],
    ["LONG_TEXT", "Ähre", "Zebra"],
    ["LINK", "https://example.org/a", "https://example.org/z"],
    ["NUMBER", 2, 10],
    ["DATE", "2030-01-01", "2031-01-01"],
    ["BOOLEAN", false, true],
    ["CHOICE", "first", "second"],
    ["MULTI_CHOICE", ["second", "first"], ["second"]],
  ])("sorts %s by its type and leaves empties last in both directions", (type, low, high) => {
    const definition = field(type);
    expect(fieldSortValue(definition, low)).not.toBeUndefined();
    for (const desc of [false, true]) {
      const columns = withFieldColumns<{ id: string; values: Record<string, ListValue> }>(
        [],
        { columns: ["field:property"], fields: [definition] },
        "de",
      );
      const table = createTable({
        data: [
          { id: "high", values: { property: high } },
          { id: "empty", values: {} },
          { id: "low", values: { property: low } },
        ],
        columns,
        state: { sorting: [{ id: "field:property", desc }] },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onStateChange: () => {},
        renderFallbackValue: null,
      });
      expect(table.getRowModel().rows.map((row) => row.original.id)).toEqual(
        desc ? ["high", "low", "empty"] : ["low", "high", "empty"],
      );
    }
    expect(fieldSortValue(definition, "")).toBeUndefined();
    expect(fieldSortValue(definition, [])).toBeUndefined();
  });

  it("searches the exact localized display text and choice labels", () => {
    expect(fieldText(field("NUMBER"), 12.5, "de")).toBe("12,5 h");
    expect(fieldText(field("NUMBER"), 12.5, "en")).toBe("12.5 h");
    expect(fieldText(field("BOOLEAN"), false, "de")).toBe("Nein");
    expect(fieldText(field("CHOICE"), "first", "en")).toBe("Zulu");
    expect(fieldText(field("MULTI_CHOICE"), ["second", "first"], "en")).toBe("Alpha, Zulu");
    expect(fieldText(field("DATE"), "2030-02-01", "de")).toContain("01.02.2030");
  });

  it("keeps only known columns, pins the name and preserves the saved order", () => {
    expect(
      resolveColumns(
        "ROOM",
        ["capacity", "field:gone", "field:active", "name", "capacity"],
        [{ id: "active" }],
      ),
    ).toEqual(["name", "capacity", "field:active"]);
  });
});
