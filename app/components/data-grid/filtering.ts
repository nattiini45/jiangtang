import type { Column, ColumnDef as TableColumnDef, Row } from "@tanstack/react-table";
import type { Locale } from "~/i18n/locales";

export type ColumnDef<TData, TValue = unknown> = TableColumnDef<TData, TValue> & {
  meta?: {
    searchText?: (row: TData, locale: Locale) => string | null | undefined;
  };
};

export interface GridFilter {
  text: string;
  locale: Locale;
}

export function searchableColumns<TData>(
  columns: ColumnDef<TData>[],
  locale: Locale,
): ColumnDef<TData>[] {
  return columns.map((column) => {
    const searchText = column.meta?.searchText;
    if (!searchText || "accessorKey" in column || "accessorFn" in column) return column;
    return {
      ...column,
      accessorFn: (row) => searchText(row, locale),
      enableSorting: column.enableSorting ?? false,
    };
  });
}

export function canFilterColumn<TData>(column: Column<TData>): boolean {
  return Boolean((column.columnDef as ColumnDef<TData>).meta?.searchText || column.accessorFn);
}

export function filterGridText<TData>(row: Row<TData>, columnId: string, filter: GridFilter) {
  const column = row.getAllCells().find((cell) => cell.column.id === columnId)!.column;
  const searchText = (column.columnDef as ColumnDef<TData>).meta?.searchText;
  const text = searchText ? searchText(row.original, filter.locale) : row.getValue(columnId);
  return (
    (typeof text === "string" || typeof text === "number") &&
    String(text).toLowerCase().includes(filter.text.toLowerCase())
  );
}
