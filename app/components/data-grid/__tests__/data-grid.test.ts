import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DataGrid, type DataGridProps } from "~/components/data-grid/data-grid";

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

describe("DataGrid growing column", () => {
  it("keeps the selected column's base width and grows its header and every cell", () => {
    const html = renderToStaticMarkup(
      createElement(DataGrid<(typeof props.data)[number]>, { ...props, growColumn: "notes" }),
    );
    expect(html.match(/width:176px;flex-grow:1/g)).toHaveLength(3);
    expect(html.match(/width:142px;flex-grow:0/g)).toHaveLength(3);
    expect(html.match(/flex-grow:1/g)).toHaveLength(3);
  });

  it.each([undefined, "missing"])("preserves fixed sizing when growColumn is %s", (growColumn) => {
    const html = renderToStaticMarkup(
      createElement(DataGrid<(typeof props.data)[number]>, { ...props, growColumn }),
    );
    expect(html).not.toContain("flex-grow:1");
    expect(html.match(/width:176px;flex-grow:0/g)).toHaveLength(3);
    expect(html.match(/width:142px;flex-grow:0/g)).toHaveLength(3);
  });
});
