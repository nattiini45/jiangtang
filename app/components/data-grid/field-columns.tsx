import type { ColumnDef } from "./filtering";
import { FieldValue } from "~/components/fields/field-values";
import {
  fieldColumnId,
  fieldDisplayValue,
  fieldSortValue,
  fieldText,
  type ListColumns,
  type ListValues,
} from "~/lib/list-columns/columns";
import type { Locale } from "~/i18n/locales";

export function withFieldColumns<T extends ListValues>(
  builtins: ColumnDef<T>[],
  config: ListColumns,
  locale: Locale,
): ColumnDef<T>[] {
  const collator = new Intl.Collator(locale);
  const all: ColumnDef<T>[] = [
    ...builtins,
    ...config.fields.map((field): ColumnDef<T> => ({
      id: fieldColumnId(field.id),
      header: field.name,
      accessorFn: (row) => fieldSortValue(field, row.values[field.id]),
      sortUndefined: "last",
      sortDescFirst: false,
      sortingFn: (a, b, id) => {
        const av = a.getValue<string | number>(id);
        const bv = b.getValue<string | number>(id);
        return typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(String(av), String(bv));
      },
      meta: {
        sizing: ["NUMBER", "BOOLEAN", "DATE", "CHOICE"].includes(field.type) ? "short" : "text",
        searchText: (row, locale) => fieldText(field, row.values[field.id], locale),
      },
      cell: ({ row }) => {
        const value = fieldDisplayValue(field, row.original.values[field.id], locale);
        const text = fieldText(field, row.original.values[field.id], locale);
        return (
          <span className="min-w-0 truncate" title={text}>
            {value == null || value === "" || (Array.isArray(value) && !value.length) ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <FieldValue compact field={{ ...field, value, section: null, position: 0 }} />
            )}
          </span>
        );
      },
    })),
  ];
  return config.columns.flatMap((id) => {
    const column = all.find(
      (column) => (column.id ?? ("accessorKey" in column ? column.accessorKey : undefined)) === id,
    );
    return column ? [column] : [];
  });
}
