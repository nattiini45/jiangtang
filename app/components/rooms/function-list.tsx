import { Form, Link } from "react-router";
import { DataGrid, type ColumnDef } from "~/components/data-grid";
import { Select } from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toneClassName } from "~/lib/status";
import { formatDate, formatDateTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import type { getFunctionList } from "~/domains/functions/functions.list.server";

type ListData = Awaited<ReturnType<typeof getFunctionList>>;
type Row = ListData["rows"][number];

export function FunctionList({
  rows,
  functions,
  campuses,
  buildings,
  filters,
  now,
  mobile = false,
}: ListData & { mobile?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const href = (row: Row) =>
    `${mobile ? "/m" : ""}/rooms/${row.roomSlug}#function-${row.functionId}`;
  const cause = (row: Row) =>
    [
      ...row.faults.map((fault) => fault.title),
      ...row.causes
        .filter((entry) => !entry.ticketId)
        .map((entry) => row.devices.find((device) => device.id === entry.deviceId)?.name)
        .filter(Boolean),
    ].join(" · ");
  const age = (row: Row) => {
    if (!row.since)
      return t("functions.before", { date: formatDate(locale, "2026-11-13T00:00:00Z") });
    const minutes = Math.max(0, Math.floor((now.getTime() - row.since.getTime()) / 60_000));
    const count =
      minutes >= 1440
        ? Math.floor(minutes / 1440)
        : minutes >= 60
          ? Math.floor(minutes / 60)
          : minutes;
    return minutes >= 1440
      ? t(count === 1 ? "functions.list.day" : "functions.list.days", { count })
      : minutes >= 60
        ? t(count === 1 ? "functions.list.hour" : "functions.list.hours", { count })
        : t(count === 1 ? "functions.list.minute" : "functions.list.minutes", { count });
  };
  const badge = (row: Row) => (
    <Badge className={toneClassName(row.state === "DOWN" ? "fault" : "warning")}>
      {t(`functions.state.${row.state}`)}
    </Badge>
  );
  const columns: ColumnDef<Row>[] = [
    {
      accessorKey: "roomName",
      header: t("tickets.form.room"),
      cell: ({ row: { original: row } }) => (
        <Link
          to={href(row)}
          className="flex min-w-0 gap-1 hover:underline"
          title={[row.roomName, row.roomNumber, row.campusName, row.buildingName]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="truncate">{row.roomName}</span>
          {row.roomNumber ? <span className="nums shrink-0">· {row.roomNumber}</span> : null}
        </Link>
      ),
    },
    {
      accessorKey: "name",
      header: t("functions.list.function"),
      cell: ({ row: { original: row } }) => (
        <Link to={href(row)} className="truncate hover:underline" title={row.name}>
          {row.name}
        </Link>
      ),
    },
    {
      accessorKey: "state",
      header: t("functions.list.state"),
      meta: { sizing: "short", searchText: (row) => t(`functions.state.${row.state}`) },
      cell: ({ row }) => badge(row.original),
    },
    {
      id: "since",
      meta: { sizing: "short" },
      accessorFn: (row) => row.since?.getTime() ?? Number.MIN_SAFE_INTEGER,
      sortDescFirst: false,
      header: t("functions.list.age"),
      enableGlobalFilter: false,
      cell: ({ row: { original: row } }) => (
        <span
          className="nums truncate"
          title={row.since ? formatDateTime(locale, row.since) : age(row)}
        >
          {age(row)}
        </span>
      ),
    },
    {
      id: "cause",
      accessorFn: cause,
      header: t("functions.list.cause"),
      cell: ({ row: { original: row } }) => (
        <Link to={href(row)} className="truncate hover:underline" title={cause(row)}>
          {cause(row)}
        </Link>
      ),
    },
    {
      id: "knownFixes",
      header: t("functions.fixes.title"),
      accessorFn: (row) => row.knownFixes.length,
      meta: { sizing: "short" },
      cell: ({ row: { original: row } }) => (
        <Link to={href(row)} className="nums hover:underline">
          {row.knownFixes.length}
        </Link>
      ),
    },
  ];
  const submit = (event: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    event.currentTarget.form?.requestSubmit();
  return (
    <div className={`flex min-w-0 flex-col gap-4 ${mobile ? "p-4" : ""}`}>
      <div>
        <h1 className="text-xl font-bold">{t("functions.list.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(rows.length === 1 ? "functions.list.one" : "functions.list.count", {
            count: rows.length,
          })}
        </p>
      </div>
      <details open={!mobile}>
        <summary
          className={mobile ? "min-h-11 cursor-pointer py-3 text-sm font-semibold" : "hidden"}
        >
          {t("functions.list.filters")}
        </summary>
        <Form method="get" className="flex flex-wrap items-center gap-2">
          <Select
            name="functionId"
            aria-label={t("functions.list.function")}
            value={filters.functionId}
            onChange={submit}
            className="w-full sm:w-48"
          >
            <option value="">{t("functions.list.allFunctions")}</option>
            {functions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
          <Select
            name="campusId"
            aria-label={t("rooms.list.filterCampus")}
            value={filters.campusId}
            onChange={submit}
            className="w-full sm:w-40"
          >
            <option value="">{t("rooms.list.allCampuses")}</option>
            {campuses.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
          <Select
            name="buildingId"
            aria-label={t("functions.list.building")}
            value={filters.buildingId}
            onChange={submit}
            className="w-full sm:w-40"
          >
            <option value="">{t("functions.list.allBuildings")}</option>
            {buildings.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
          <Select
            name="state"
            aria-label={t("functions.list.state")}
            value={filters.state}
            onChange={submit}
            className="w-full sm:w-40"
          >
            <option value="">{t("functions.list.allStates")}</option>
            <option value="DOWN">{t("functions.state.DOWN")}</option>
            <option value="LIMITED">{t("functions.state.LIMITED")}</option>
          </Select>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <Checkbox
              name="unassigned"
              value="true"
              checked={filters.unassigned}
              onChange={submit}
            />
            {t("functions.list.unassigned")}
          </label>
          {mobile ? (
            <Select
              name="sort"
              aria-label={t("functions.list.age")}
              value={filters.newestFirst ? "newest" : "oldest"}
              onChange={submit}
            >
              <option value="oldest">{t("functions.list.oldest")}</option>
              <option value="newest">{t("functions.list.newest")}</option>
            </Select>
          ) : null}
          <noscript>
            <Button type="submit">{t("rooms.list.filterSubmit")}</Button>
          </noscript>
        </Form>
      </details>
      {mobile ? (
        <ul className="divide-y rounded-lg bg-card shadow-surface-2">
          {rows.map((row) => (
            <li key={`${row.roomId}-${row.functionId}`}>
              <Link to={href(row)} className="flex min-h-12 flex-col gap-2 p-3 hover:bg-hover">
                <span className="flex min-w-0 gap-1 text-sm font-semibold" title={row.roomName}>
                  <span className="truncate">{row.roomName}</span>
                  {row.roomNumber ? (
                    <span className="nums shrink-0">· {row.roomNumber}</span>
                  ) : null}
                </span>
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={[row.campusName, row.buildingName].filter(Boolean).join(" · ")}
                >
                  {[row.campusName, row.buildingName].filter(Boolean).join(" · ")}
                </span>
                <span className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>{row.name}</span>
                  {badge(row)}
                </span>
                <span className="text-xs text-muted-foreground">{age(row)}</span>
                {row.knownFixes.length ? (
                  <span className="text-xs">
                    {t("functions.fixes.count", { count: row.knownFixes.length })}
                  </span>
                ) : null}
                <span className="truncate text-sm" title={cause(row)}>
                  {cause(row)}
                </span>
              </Link>
            </li>
          ))}
          {!rows.length ? (
            <li className="p-4 text-sm text-muted-foreground">{t("functions.list.empty")}</li>
          ) : null}
        </ul>
      ) : (
        <DataGrid
          columns={columns}
          data={rows}
          growColumn="cause"
          stickyColumn="roomName"
          initialSorting={[{ id: "since", desc: false }]}
          getRowId={(row) => `${row.roomId}-${row.functionId}`}
          emptyMessage={t("functions.list.empty")}
          maxHeight="calc(100dvh - 290px)"
        />
      )}
    </div>
  );
}
