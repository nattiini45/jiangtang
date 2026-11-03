import * as React from "react";
import {
  type ColumnDef,
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
import { useT } from "~/i18n/use-t";
import { Input } from "~/components/ui/input";

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
  getRowId?: (row: TData, index: number) => string;
}

export function DataGrid<TData>({
  columns,
  data,
  density,
  filter = true,
  emptyMessage,
  maxHeight = 600,
  className,
  getRowId,
}: DataGridProps<TData>) {
  const t = useT();
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");

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
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    defaultColumn: { size: 160, minSize: 60 },
  });

  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[effectiveDensity];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  return (
    <div
      className={cn("bg-card shadow-surface-2 flex flex-col overflow-hidden rounded-lg", className)}
    >
      {filter ? (
        <div className="border-b p-2">
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={t("common.dataGrid.filterPlaceholder")}
            aria-label={t("common.dataGrid.filterLabel")}
            className="h-8 max-w-xs bg-transparent"
          />
        </div>
      ) : null}

      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight }}>
        {/* Header */}
        <div className="bg-card sticky top-0 z-10">
          {table.getHeaderGroups().map((hg) => (
            <div key={hg.id} className="flex border-b">
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <div
                    key={header.id}
                    className="text-muted-foreground flex h-control shrink-0 items-center px-3 text-xs font-semibold"
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder ? null : (
                      <button
                        type="button"
                        disabled={!canSort}
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "-mx-1 inline-flex items-center gap-1 rounded-xs px-1 transition-colors duration-80",
                          canSort && "hover:text-foreground cursor-pointer",
                          sorted && "text-foreground",
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
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
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index];
              return (
                <div
                  key={row.id}
                  className="hover:bg-hover absolute top-0 left-0 flex w-full border-b transition-colors duration-80 last:border-b-0"
                  style={{ height: rowHeight, transform: `translateY(${vr.start}px)` }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div
                      key={cell.id}
                      className="flex shrink-0 items-center truncate px-3"
                      style={{ width: cell.column.getSize() }}
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
  );
}
