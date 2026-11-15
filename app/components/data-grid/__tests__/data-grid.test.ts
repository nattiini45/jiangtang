import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DataGrid, type DataGridProps } from "~/components/data-grid/data-grid";
import { layoutWidths, readWidths, saveWidths } from "../column-widths";

vi.mock("~/i18n/use-t", () => ({ useT: () => (key: string) => key, useLocale: () => "de" }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 36,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 36 })),
  }),
}));

const props: DataGridProps<{ name: string; notes: string }> = {
  columns: [
    { accessorKey: "name", header: "Name", size: 142 },
    { accessorKey: "notes", header: "Notes", size: 176 },
  ],
  data: [
    { name: "Synthetic hall", notes: "Synthetic problem" },
    { name: "Empty hall", notes: "" },
  ],
};

describe("DataGrid column widths", () => {
  it("aligns headers and cells using the shared layout", () => {
    const html = renderToStaticMarkup(
      createElement(DataGrid<(typeof props.data)[number]>, { ...props, growColumn: "notes" }),
    );
    expect(html.match(/width:160px/g)).toHaveLength(6);
    expect(html.match(/role="separator"/g)).toHaveLength(2);
  });

  const columns = [
    { id: "name", short: false, content: 400 },
    { id: "status", short: true, content: 100 },
    { id: "notes", short: false, content: 200 },
  ];
  it("fits short columns and shares spare space between text columns", () => {
    expect(layoutWidths(columns, 1000, {})).toEqual({ name: 510, status: 100, notes: 390 });
  });
  it("shrinks text fairly without squeezing it below its readable minimum", () => {
    const widths = layoutWidths(columns, 450, {});
    expect(widths.name + widths.status + widths.notes).toBe(450);
    expect(widths.name).toBeGreaterThanOrEqual(160);
    expect(widths.notes).toBeGreaterThanOrEqual(160);
    expect(layoutWidths(columns, 200, {})).toEqual({ name: 160, status: 100, notes: 160 });
  });
  it("keeps resized columns fixed while other text uses the remaining space", () => {
    expect(layoutWidths(columns, 1000, { notes: 450 })).toEqual({
      name: 450,
      status: 100,
      notes: 450,
    });
  });
  it.each(["broken", "null", "[]", '{"name":-1,"status":"100"}', '{"name":2001}'])(
    "ignores invalid stored widths: %s",
    (value) => {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(readWidths("table")).toEqual({});
      vi.unstubAllGlobals();
    },
  );
  it("loads only numeric widths and tolerates unavailable browser storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => '{"name":360,"status":64,"notes":2000}',
      setItem: () => {
        throw new Error("Storage unavailable");
      },
    });
    expect(readWidths("table")).toEqual({ name: 360, status: 64, notes: 2000 });
    expect(() => saveWidths("table", { name: 360 })).not.toThrow();
    vi.unstubAllGlobals();
  });
});
