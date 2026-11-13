import * as React from "react";
import {
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "~/lib/utils";
import type { Density } from "~/lib/theme.server";
import { currentDensity, PREF_CHANGED_EVENT } from "~/lib/prefs";
import { useLocale, useT } from "~/i18n/use-t";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { resetWidths, MIN_WIDTH, MAX_WIDTH } from "./column-widths";
import { useColumnWidths } from "./use-column-widths";
import { canFilterColumn, filterGridText, searchableColumns, type ColumnDef } from "./filtering";

/**
 * Shared virtualized data grid (TanStack Table v8 + Virtual). Tracks pass
 * `columns` + `data`; never fork this. Div-based layout so the sticky header and
 * virtualized body share one column-sizing model (alignment stays correct).
 */

// Rows sit on the size ladder, the same height as the controls beside them.
// Virtualized rows move under the pointer as the list scrolls, so they get a
// plain per-row hover rather than the gliding one.
const ROW_HEIGHT: Record<Density, number> = { compact: 28, comfortable: 36 };

export interface DataGridProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  density?: Density;
  /** Show the global filter box. */
  filter?: boolean;
  /** Empty-state content — a string or a composed `EmptyState`. */
  emptyMessage?: React.ReactNode;
  maxHeight?: number | string;
  className?: string;
  growColumn?: string;
  tableId?: string;
  widthsMenu?: boolean;
  stickyColumn?: string;
  getRowId?: (row: TData, index: number) => string;
  initialSorting?: SortingState;
}

export function DataGrid<TData>({
  columns,
  data,
  density,
  filter = true,
  emptyMessage,
  maxHeight = 600,
  className,
  tableId = "list",
  widthsMenu = true,
  stickyColumn,
  getRowId,
  initialSorting = [],
}: DataGridProps<TData>) {
  const t = useT();
  const locale = useLocale();
  const filterColumns = React.useMemo(() => searchableColumns(columns, locale), [columns, locale]);
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const filterValue = React.useMemo(
    () => (globalFilter ? { text: globalFilter, locale } : undefined),
    [globalFilter, locale],
  );

  // Density: the prop still wins, but omitted it follows the user's
  // toggle — `document.documentElement.dataset.density` + PREF_CHANGED_EVENT,
  // read after mount so SSR/hydration stays deterministic at "comfortable".
  const [liveDensity, setLiveDensity] = React.useState<Density>("comfortable");
  React.useEffect(() => {
    const read = () => setLiveDensity(currentDensity());
    read();
    window.addEventListener(PREF_CHANGED_EVENT, read);
    return () => window.removeEventListener(PREF_CHANGED_EVENT, read);
  }, []);
  const effectiveDensity = density ?? liveDensity;

  const table = useReactTable({
    data,
    columns: filterColumns,
    state: { sorting, globalFilter: filterValue },
    onSortingChange: setSorting,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getColumnCanGlobalFilter: canFilterColumn,
    globalFilterFn: filterGridText,
    defaultColumn: { size: 160, minSize: 60 },
  });

  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[effectiveDensity];
  const { widths, resize, fit } = useColumnWidths(
    table,
    scrollRef,
    tableId,
    locale,
    data,
    filterColumns,
    effectiveDensity,
  );
  const totalWidth = Object.values(widths).reduce((sum, width) => sum + width, 0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  return (
    <div
      className={cn(
        "bg-card shadow-surface-2 flex min-w-0 max-w-full flex-col overflow-hidden rounded-lg",
        className,
      )}
    >
      {filter || widthsMenu ? (
        <div className="flex items-center justify-between gap-2 border-b p-2">
          {filter ? (
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={t("common.dataGrid.filterPlaceholder")}
              aria-label={t("common.dataGrid.filterLabel")}
              className="h-8 max-w-xs bg-transparent"
            />
          ) : (
            <span />
          )}
          {widthsMenu ? (
            <details className="relative shrink-0">
              <summary className="hover:bg-hover flex h-control cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-semibold">
                {t("fields.columns.title")}
                <ChevronDown className="size-4" />
              </summary>
              <div className="bg-card shadow-surface-3 absolute right-0 z-30 mt-2 w-max rounded-lg p-2">
                <Button type="button" variant="ghost" onClick={() => resetWidths(tableId)}>
                  {t("common.dataGrid.resetWidths")}
                </Button>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        role="table"
        aria-rowcount={rows.length + 1}
        className="overflow-auto"
        style={{ maxHeight }}
      >
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          {/* Header */}
          <div role="rowgroup" className="bg-card sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <div key={hg.id} role="row" className="flex border-b">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <div
                      key={header.id}
                      role="columnheader"
                      data-column-id={header.column.id}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        "text-muted-foreground relative flex h-control shrink-0 items-center px-3 text-xs font-semibold",
                        header.column.id === stickyColumn && "bg-card sticky left-0 z-20",
                      )}
                      style={{
                        width: widths[header.column.id],
                      }}
                    >
                      {header.isPlaceholder ? null : (
                        <button
                          type="button"
                          disabled={!canSort}
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex min-w-0 items-center gap-1 rounded-xs px-1 transition-colors duration-80 [&>svg]:shrink-0",
                            canSort && "hover:text-foreground cursor-pointer",
                            sorted && "text-foreground",
                          )}
                        >
                          <span
                            className="truncate"
                            title={String(header.column.columnDef.header ?? "")}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {canSort ? (
                            sorted === "asc" ? (
                              <ChevronUp className="size-3.5" />
                            ) : sorted === "desc" ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronsUpDown className="size-3.5" strokeWidth={1.5} />
                            )
                          ) : null}
                        </button>
                      )}
                      <div
                        role="separator"
                        tabIndex={0}
                        aria-orientation="vertical"
                        aria-label={t("common.dataGrid.resizeColumn", {
                          name: String(header.column.columnDef.header ?? header.column.id),
                        })}
                        aria-valuemin={MIN_WIDTH}
                        aria-valuemax={MAX_WIDTH}
                        aria-valuenow={Math.round(widths[header.column.id])}
                        title={t("common.dataGrid.resizeHelp")}
                        className="hover:bg-border focus-visible:bg-border absolute inset-y-0 right-0 z-10 w-2 touch-none cursor-col-resize select-none"
                        onDoubleClick={() => fit(header.column.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") fit(header.column.id);
                          else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                            resize(
                              header.column.id,
                              widths[header.column.id] +
                                (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10),
                            );
                          } else return;
                          event.preventDefault();
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          event.currentTarget.focus();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          event.currentTarget.dataset.startX = String(event.clientX);
                          event.currentTarget.dataset.startWidth = String(widths[header.column.id]);
                        }}
                        onPointerMove={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            resize(
                              header.column.id,
                              Number(event.currentTarget.dataset.startWidth) +
                                event.clientX -
                                Number(event.currentTarget.dataset.startX),
                            );
                        }}
                        onPointerUp={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Body */}
          {rows.length === 0 ? (
            <div className="text-muted-foreground p-6 text-center text-sm">
              {emptyMessage ?? t("common.dataGrid.empty")}
            </div>
          ) : (
            <div
              role="rowgroup"
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
            >
              {virtualizer.getVirtualItems().map((vr) => {
                const row = rows[vr.index];
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-rowindex={vr.index + 2}
                    data-row-id={row.id}
                    className="group hover:bg-hover absolute top-0 left-0 flex w-full border-b transition-colors duration-80 last:border-b-0"
                    style={{ height: rowHeight, transform: `translateY(${vr.start}px)` }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        role="cell"
                        data-column-id={cell.column.id}
                        ref={(element) => {
                          if (element) element.title = element.textContent ?? "";
                        }}
                        className={cn(
                          "shrink-0 content-center truncate px-3",
                          cell.column.id === stickyColumn &&
                            "bg-card sticky left-0 z-10 group-hover:bg-[image:linear-gradient(var(--hover),var(--hover))]",
                        )}
                        style={{
                          width: widths[cell.column.id],
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
