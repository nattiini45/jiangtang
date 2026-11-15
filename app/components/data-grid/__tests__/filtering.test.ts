import {
  createTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import { describe, expect, it } from "vitest";
import { canFilterColumn, filterGridText, searchableColumns, type ColumnDef } from "../filtering";
import { roomColumns } from "~/components/rooms/room-columns";
import { equipmentColumns } from "~/components/inventory/equipment-columns";
import { modelColumns } from "~/components/inventory/model-columns";
import { stockColumns } from "~/components/inventory/stock-columns";
import { ticketColumns } from "~/components/tickets/ticket-columns";
import { taskColumns } from "~/components/tasks/task-columns";
import { projectColumns } from "~/components/projects/project-columns";
import { eventColumns } from "~/components/events/event-columns";
import { usersColumns } from "~/components/auth/users-columns";
import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import type { RoomListRow } from "~/domains/rooms/rooms.queries.server";

function filtered<TData>(
  columns: ColumnDef<TData>[],
  data: TData[],
  text: string,
  locale: Locale = "de",
) {
  return createTable({
    columns: searchableColumns(columns, locale),
    data,
    state: { globalFilter: { text, locale } },
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getColumnCanGlobalFilter: canFilterColumn,
    globalFilterFn: filterGridText,
  })
    .getRowModel()
    .rows.map((row) => row.original);
}

describe("grid text filtering", () => {
  it("searches every optional room text and number after an entirely empty first row", () => {
    const columns = roomColumns((key, params) => t("de", key, params));
    const empty: RoomListRow = {
      id: "empty",
      slug: "empty",
      name: "First",
      buildingName: null,
      roomNumber: null,
      campusName: null,
      knownIssues: null,
      capacity: null,
      status: "ALL_GOOD",
      equipmentCount: 0,
      lastCheckedAt: null,
    };
    const later = {
      ...empty,
      name: "Second",
      roomNumber: "R-789",
      campusName: "West campus",
      knownIssues: "HDMI flickers",
      capacity: 427,
    };
    for (const text of ["Second", "R-789", "West", "HDMI", "427"]) {
      expect(filtered(columns, [empty, later], text)).toEqual([later]);
    }
  });

  it.each(["de", "en"] as const)(
    "searches localized status, not its stored key, in %s",
    (locale) => {
      const columns = roomColumns((key, params) => t(locale, key, params));
      const room = { status: "MAINTENANCE_NEEDED" };
      expect(
        filtered(columns, [room] as never, t(locale, "status.room.MAINTENANCE_NEEDED"), locale),
      ).toEqual([room]);
      expect(filtered(columns, [room] as never, "MAINTENANCE_NEEDED", locale)).toEqual([]);
    },
  );

  it("supports display-only search text and explicit opt-out without inspecting the first row", () => {
    const columns: ColumnDef<{ label: string }>[] = [
      { id: "display", meta: { searchText: (row) => row.label } },
      { accessorKey: "label", enableGlobalFilter: false },
      { id: "other", meta: { searchText: () => "Other" } },
    ];
    expect(filtered(columns, [{ label: "Visible" }], "vis")).toHaveLength(1);
    columns[0].enableGlobalFilter = false;
    expect(filtered(columns, [{ label: "Visible" }], "vis")).toHaveLength(0);
  });

  it("preserves known-problem null ordering and leaves display-only columns unsortable", () => {
    const columns = roomColumns((key, params) => t("de", key, params));
    const data = ["b", null, "a", null].map((knownIssues) => ({ knownIssues }));
    const table = createTable({
      data: data as RoomListRow[],
      columns,
      state: { sorting: [{ id: "knownIssues", desc: false }] },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
    });
    expect(table.getRowModel().rows.map((row) => row.original.knownIssues)).toEqual([
      null,
      null,
      "a",
      "b",
    ]);
    const display = searchableColumns(
      usersColumns((key, params) => t("de", key, params)),
      "de",
    );
    expect(display.find((column) => column.id === "isActive")?.enableSorting).toBe(false);
  });

  it.each(["de", "en"] as const)("uses the labels declared by each list in %s", (locale) => {
    const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
      t(locale, key, params);
    const cases = [
      [
        equipmentColumns(tr, locale),
        "status",
        { status: "FAULTY" },
        tr("status.equipment.FAULTY"),
        "FAULTY",
      ],
      [
        equipmentColumns(tr, locale),
        "kind",
        { kind: { id: "hidden-kind-id", name: "Demo-Geräteart" } },
        "Demo-Geräteart",
        "hidden-kind-id",
      ],
      [
        modelColumns(tr, locale),
        "kind",
        { kind: { id: "hidden-kind-id", name: "Demo-Geräteart" } },
        "Demo-Geräteart",
        "hidden-kind-id",
      ],
      [stockColumns(tr), "status", { status: "ON_LOAN" }, tr("status.stock.ON_LOAN"), "ON_LOAN"],
      [
        ticketColumns(tr, locale),
        "status",
        { status: "IN_PROGRESS" },
        tr("status.ticket.IN_PROGRESS"),
        "IN_PROGRESS",
      ],
      [ticketColumns(tr, locale), "priority", { priority: 1 }, tr("tickets.priority.1"), "1"],
      [
        ticketColumns(tr, locale),
        "type",
        { type: "INCIDENT" },
        tr("search.ticketType.INCIDENT"),
        "INCIDENT",
      ],
      [
        taskColumns(tr),
        "status",
        { status: "IN_PROGRESS" },
        tr("status.task.IN_PROGRESS"),
        "IN_PROGRESS",
      ],
      [
        taskColumns(tr),
        "priority",
        { priority: "URGENT" },
        tr("status.taskPriority.URGENT"),
        "URGENT",
      ],
      [
        projectColumns(tr),
        "status",
        { status: "AWAITING_FEEDBACK" },
        tr("status.project.AWAITING_FEEDBACK"),
        "AWAITING_FEEDBACK",
      ],
      [
        eventColumns(tr),
        "status",
        { status: "IN_PROGRESS" },
        tr("status.event.IN_PROGRESS"),
        "IN_PROGRESS",
      ],
      [usersColumns(tr), "role", { role: "MEMBER" }, tr("auth.role.MEMBER"), "MEMBER"],
      [
        usersColumns(tr),
        "emailVerified",
        { emailVerified: true },
        tr("admin.users.verified"),
        "true",
      ],
      [usersColumns(tr), "isActive", { isActive: false }, tr("admin.users.inactive"), "false"],
      [
        usersColumns(tr),
        "twoFactorEnabled",
        { twoFactorEnabled: true },
        tr("admin.users.twoFactorOn"),
        "true",
      ],
    ] as const;
    for (const [columns, id, row, label, stored] of cases) {
      const column = columns.find(
        (column) => column.id === id || ("accessorKey" in column && column.accessorKey === id),
      )!;
      expect(
        filtered([column] as ColumnDef<unknown>[], [row], label, locale),
        `${id}: ${label}`,
      ).toEqual([row]);
      if (!label.toLowerCase().includes(stored.toLowerCase())) {
        expect(filtered([column] as ColumnDef<unknown>[], [row], stored, locale)).toEqual([]);
      }
    }
  });

  it("searches visible relation labels without stringifying hidden objects", () => {
    const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
      t("de", key, params);
    const cases = [
      [
        stockColumns(tr),
        "location",
        null,
        { name: "Store", kind: "RACK", id: "hidden-key" },
        "Store",
      ],
      [stockColumns(tr), "vendor", null, { name: "Supplier", id: "hidden-key" }, "Supplier"],
      [stockColumns(tr), "equipment", null, { name: "Device", assetTag: "hidden-key" }, "Device"],
      [
        taskColumns(tr),
        "project",
        null,
        { name: "Installation", id: "hidden-key" },
        "Installation",
      ],
      [
        taskColumns(tr),
        "assignees",
        [],
        [{ user: { name: "Hidden name", initials: "AB" }, userId: "hidden-key" }],
        "AB",
      ],
      [taskColumns(tr), "labels", [], ["Cabling", "Support"], "Cabling"],
      [projectColumns(tr), "lead", null, { name: "Coordinator", id: "hidden-key" }, "Coordinator"],
    ] as const;
    for (const [columns, id, empty, value, text] of cases) {
      const column = columns.find(
        (column) => "accessorKey" in column && column.accessorKey === id,
      )!;
      const first = { [id]: empty };
      const later = { [id]: value };
      expect(filtered([column] as ColumnDef<unknown>[], [first, later], text)).toEqual([later]);
      expect(filtered([column] as ColumnDef<unknown>[], [first, later], "hidden-key")).toEqual([]);
    }
  });

  it("keeps dates, numeric counts, count summaries and actions unchanged", () => {
    const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
      t("de", key, params);
    const checked = new Date("2042-06-15T08:00:00Z");
    expect(
      filtered(
        roomColumns(tr),
        [
          { status: "ALL_GOOD", lastCheckedAt: null },
          { status: "ALL_GOOD", lastCheckedAt: checked },
        ] as never,
        String(checked.getTime()),
      ),
    ).toEqual([]);
    const dates = eventColumns(tr).filter(
      (column) => "accessorKey" in column && column.accessorKey === "startsAt",
    );
    expect(
      filtered(dates, [{ startsAt: new Date("2042-06-15T08:00:00Z") }] as never, "2042"),
    ).toEqual([]);
    const counts = modelColumns(tr, "de").filter(
      (column) => "accessorKey" in column && column.accessorKey === "instanceCount",
    );
    expect(filtered(counts, [{ instanceCount: 427 }] as never, "427")).toHaveLength(1);
    const summaries = projectColumns(tr).filter(
      (column) => "accessorKey" in column && column.accessorKey === "tasks",
    );
    expect(
      filtered(summaries, [{ tasks: { done: 427, total: 427, open: 0 } }] as never, "427"),
    ).toEqual([]);
    expect(canFilterColumn({ accessorFn: undefined, columnDef: { id: "actions" } } as never)).toBe(
      false,
    );
  });
});
