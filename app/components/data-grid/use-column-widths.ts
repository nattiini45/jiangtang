import * as React from "react";
import type { Table } from "@tanstack/react-table";
import type { Locale } from "~/i18n/locales";
import type { ColumnDef } from "./filtering";
import {
  layoutWidths,
  MAX_WIDTH,
  MIN_WIDTH,
  readWidths,
  saveWidths,
  widthKey,
  WIDTHS_CHANGED,
  type Widths,
} from "./column-widths";

export function useColumnWidths<T>(
  table: Table<T>,
  ref: React.RefObject<HTMLDivElement | null>,
  tableId: string,
  locale: Locale,
  data: T[],
  columns: ColumnDef<T>[],
  density: string,
) {
  const [saved, setSaved] = React.useState<Widths>({});
  const [content, setContent] = React.useState<Widths>({});
  const [available, setAvailable] = React.useState(0);
  React.useEffect(() => {
    const key = widthKey(tableId);
    setSaved(readWidths(key));
    const reset = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) setSaved(readWidths(key));
    };
    window.addEventListener(WIDTHS_CHANGED, reset);
    return () => window.removeEventListener(WIDTHS_CHANGED, reset);
  }, [tableId]);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      const font = getComputedStyle(element);
      const measured: Widths = {};
      for (const column of table.getAllLeafColumns()) {
        context.font = `600 12px ${font.fontFamily}`;
        let width = context.measureText(String(column.columnDef.header ?? column.id)).width + 46;
        context.font = `400 13px ${font.fontFamily}`;
        const search = (column.columnDef as ColumnDef<T>).meta?.searchText;
        for (const row of table.getCoreRowModel().rows) {
          const value = search?.(row.original, locale) ?? row.getValue(column.id);
          if (typeof value === "string" || (typeof value === "number" && Math.abs(value) < 1e10))
            width = Math.max(width, context.measureText(String(value)).width + 28);
        }
        let widest: HTMLElement | undefined;
        let longest = -1;
        for (const cell of element.querySelectorAll<HTMLElement>("[data-column-id]")) {
          if (cell.dataset.columnId !== column.id || cell.getAttribute("role") !== "cell") continue;
          const text = cell.textContent ?? "";
          const length = context.measureText(text).width;
          width = Math.max(width, length + 28);
          if (length > longest) {
            widest = cell;
            longest = length;
          }
        }
        if (widest) {
          const clone = widest.cloneNode(true) as HTMLElement;
          Object.assign(clone.style, {
            position: "fixed",
            visibility: "hidden",
            width: "max-content",
            fontFamily: font.fontFamily,
          });
          for (const child of clone.querySelectorAll<HTMLElement>("*"))
            child.style.maxWidth = "none";
          if (clone.firstElementChild instanceof HTMLElement)
            clone.firstElementChild.style.width = "max-content";
          element.append(clone);
          width = Math.max(width, clone.getBoundingClientRect().width);
          clone.remove();
        }
        measured[column.id] = Math.ceil(Math.min(MAX_WIDTH, width));
      }
      setContent((previous) =>
        JSON.stringify(previous) === JSON.stringify(measured) ? previous : measured,
      );
    };
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      cancelled = true;
    };
  }, [table, ref, locale, data, columns, density]);
  const widths = layoutWidths(
    table.getAllLeafColumns().map((column) => ({
      id: column.id,
      short: (column.columnDef as ColumnDef<T>).meta?.sizing === "short",
      content: content[column.id] ?? 160,
    })),
    available,
    saved,
  );
  const resize = (id: string, width: number) => {
    setSaved((previous) => {
      const next = {
        ...previous,
        [id]: Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))),
      };
      saveWidths(widthKey(tableId), next);
      return next;
    });
  };
  return { widths, resize, fit: (id: string) => resize(id, content[id] ?? 160) };
}
