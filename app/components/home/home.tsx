import { DueItems } from "./due";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import { ArrowDown, ArrowUp, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { buttonVariants } from "~/components/ui/button";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatDateTime, formatTime } from "~/i18n/format";
import { actionLabel } from "~/components/history/labels";
import { taskStatusLabel } from "~/components/tasks/labels";
import { ticketStatusLabel } from "~/components/tickets/labels";
import type { TaskStatus, TicketStatus } from "~/generated/prisma/client";
import type { HomeData } from "~/domains/dashboard/home.queries.server";
import {
  defaultHomeLayout,
  HOME_MODES,
  visibleHomeLayout,
  type HomeLayout,
  type HomeBlock,
} from "~/domains/dashboard/home-layout";

const LINK =
  "min-w-0 truncate underline-offset-4 decoration-(--input) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const CONTROL = `${buttonVariants({ variant: "secondary" })} min-h-12`;

function Customise({
  layout,
  heading,
  entry,
}: {
  layout: HomeLayout;
  heading: ReactNode;
  entry: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(layout);
  const [saved, setSaved] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const fetcher = useFetcher<{ ok: boolean }>();
  const pending = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setOpen(false);
      setSaved(true);
      trigger.current?.focus();
    }
  }, [fetcher.state, fetcher.data]);
  const move = (index: number, offset: number) => {
    const next = [...draft];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setDraft(next);
  };
  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        if (value) {
          fetcher.reset();
          setDraft(layout);
          setSaved(false);
        }
        setOpen(value);
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        {heading}
        <div className="flex flex-wrap gap-2">
          {entry}
          <CollapsibleTrigger ref={trigger} type="button" className={CONTROL}>
            <SlidersHorizontal className="size-4" aria-hidden />
            {t("dashboard.home.customise")}
          </CollapsibleTrigger>
        </div>
      </div>
      {saved && !open ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {t("dashboard.home.saved")}
        </p>
      ) : null}
      <CollapsiblePanel>
        <fetcher.Form
          method="post"
          action="/home-layout"
          className="bg-card shadow-surface-2 mt-3 rounded-lg p-4"
          aria-label={t("dashboard.home.customise")}
        >
          <p className="text-muted-foreground mb-3 text-sm">{t("dashboard.home.help")}</p>
          <input type="hidden" name="layout" value={JSON.stringify(draft)} />
          <ol className="divide-y">
            {draft.map((item, index) => (
              <li
                key={item.id}
                className="flex flex-wrap items-end gap-2 py-3"
                data-block-control={item.id}
              >
                <Select
                  items={HOME_MODES.map((mode) => ({
                    value: mode,
                    label: t(`dashboard.home.mode.${mode}`),
                  }))}
                  value={item.mode}
                  onValueChange={(mode) => {
                    if (mode)
                      setDraft(
                        draft.map((entry) =>
                          entry.id === item.id
                            ? { ...entry, mode: mode as typeof item.mode }
                            : entry,
                        ),
                      );
                  }}
                  disabled={pending}
                >
                  <div className="min-w-0 flex-1 basis-44">
                    <SelectLabel className="mb-1 block text-sm font-semibold">
                      {t(`dashboard.home.${item.id}.title`)}
                    </SelectLabel>
                    <SelectTrigger className={`${CONTROL} w-full justify-between`}>
                      <SelectValue />
                      <ChevronDown className="size-4" aria-hidden />
                    </SelectTrigger>
                  </div>
                  <SelectContent className="bg-popover text-popover-foreground shadow-surface-3 z-50 min-w-(--anchor-width) rounded-lg p-1">
                    {HOME_MODES.map((mode) => (
                      <SelectItem
                        key={mode}
                        value={mode}
                        className="flex min-h-12 cursor-pointer items-center rounded-md px-3 text-sm outline-none data-highlighted:bg-hover data-selected:font-semibold"
                      >
                        {t(`dashboard.home.mode.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  disabled={pending || index === 0}
                  onClick={() => move(index, -1)}
                  className={`${CONTROL} w-12 px-0`}
                  aria-label={t("dashboard.home.up", {
                    block: t(`dashboard.home.${item.id}.title`),
                  })}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  disabled={pending || index === draft.length - 1}
                  onClick={() => move(index, 1)}
                  className={`${CONTROL} w-12 px-0`}
                  aria-label={t("dashboard.home.down", {
                    block: t(`dashboard.home.${item.id}.title`),
                  })}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
          {fetcher.data?.ok === false ? (
            <p role="alert" className="my-2 text-sm text-destructive">
              {t("dashboard.home.invalid")}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending} className={`${buttonVariants()} min-h-12`}>
              {t(pending ? "common.saving" : "common.save")}
            </Button>
            <Button
              type="button"
              disabled={pending}
              className={CONTROL}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={pending}
              className={CONTROL}
              onClick={() => setDraft(defaultHomeLayout())}
            >
              {t("dashboard.home.reset")}
            </Button>
          </div>
        </fetcher.Form>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}

export function Home({ data, mobile = false }: { data: HomeData; mobile?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const path = (href: string) => (mobile ? `/m${href}` : href);
  const roomPath = (slug: string) => `${path(`/rooms/${slug}`)}#functions`;
  const layout = visibleHomeLayout(data.layout);
  const more = (total: number, shown: number) =>
    total > shown ? (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("dashboard.home.more", { count: total - shown })}
      </p>
    ) : null;
  const empty = (id: HomeBlock) => (
    <p className="text-sm text-muted-foreground">{t(`dashboard.home.${id}.empty`)}</p>
  );
  const render = (id: HomeBlock, limit: number) => {
    if (id === "faults")
      return (
        <>
          {data.faults.roomCount ? (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                {t("dashboard.home.faults.count", {
                  rooms: data.faults.roomCount,
                  functions: data.faults.functionCount,
                })}
              </p>
              <Rows>
                {data.faults.rooms.slice(0, limit).map((room) => (
                  <li
                    key={room.id}
                    className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-x-6"
                  >
                    <div className="min-w-0">
                      <Link
                        to={roomPath(room.slug)}
                        className={`${LINK} block font-semibold`}
                        title={room.name}
                      >
                        {room.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground" title={room.location}>
                        {[room.number, room.location].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <ul className="flex flex-wrap gap-x-3 gap-y-1">
                        {room.functions.map((fn) => (
                          <li key={fn.id} className="flex min-w-0 items-center gap-1.5 text-sm">
                            <span
                              aria-hidden
                              className={`size-2 shrink-0 rounded-full ${fn.state === "DOWN" ? "bg-status-fault" : "bg-status-warning"}`}
                            />
                            <span className="min-w-0 truncate">
                              {fn.name} · {t(`functions.state.${fn.state as "DOWN" | "LIMITED"}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {room.fault ? (
                        <p
                          className="mt-1 truncate text-sm text-muted-foreground"
                          title={room.fault}
                        >
                          {room.fault}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {room.since
                          ? t("dashboard.home.since", { date: formatDate(locale, room.since) })
                          : t("dashboard.home.unknownAge")}
                      </p>
                    </div>
                  </li>
                ))}
              </Rows>
              {more(data.faults.roomCount, Math.min(limit, data.faults.rooms.length))}
            </>
          ) : (
            empty(id)
          )}
          <Link className={`${LINK} mt-3 inline-block text-sm`} to={path("/functions")}>
            {t("dashboard.home.faults.link")}
          </Link>
        </>
      );
    if (id === "due") return <DueItems due={data.due} mobile={mobile} limit={limit} />;
    if (id === "today")
      return (
        <>
          {data.today.count ? (
            <Rows>
              {data.today.events.slice(0, limit).map((event) => (
                <li key={event.id} className="min-w-0 py-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                    <span className="nums text-xs text-muted-foreground">
                      {formatTime(locale, event.startsAt)}–{formatTime(locale, event.endsAt)}
                    </span>
                    <Link
                      className={`${LINK} flex-1 basis-40 font-semibold`}
                      to={path(`/events/${event.id}`)}
                      title={event.title}
                    >
                      {event.title}
                    </Link>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {event.rooms.map((room) => (
                      <li key={room.id} className="min-w-0 text-sm">
                        <Link
                          to={roomPath(room.slug)}
                          className={`${LINK} block`}
                          title={room.name}
                        >
                          {room.name}
                          {room.roomNumber ? ` · ${room.roomNumber}` : ""}
                        </Link>
                        <p className="nums text-xs text-muted-foreground">
                          {t("dashboard.home.booking", {
                            from: formatTime(locale, room.startsAt),
                            to: formatTime(locale, room.endsAt),
                          })}
                        </p>
                        {room.down.length ? (
                          <p className="mt-1 text-sm text-destructive">
                            {t("dashboard.home.roomDown", { functions: room.down.join(", ") })}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </Rows>
          ) : (
            empty(id)
          )}
          {more(data.today.count, Math.min(limit, data.today.events.length))}
          <Link
            className={`${LINK} mt-3 inline-block text-sm`}
            to={path(`/calendar?date=${data.date}`)}
          >
            {t("dashboard.home.today.link")}
          </Link>
        </>
      );
    if (id === "mine")
      return (
        <>
          {data.mine.taskCount + data.mine.ticketCount ? (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                {t("dashboard.home.mine.count", {
                  tasks: data.mine.taskCount,
                  tickets: data.mine.ticketCount,
                })}
              </p>
              <Rows>
                {data.mine.items.slice(0, limit).map((item) => (
                  <li key={`${item.kind}:${item.id}`} className="min-w-0 py-3">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                      <Link
                        className={`${LINK} flex-1 basis-44 font-semibold`}
                        title={item.title}
                        to={path(`/${item.kind === "task" ? "tasks" : "tickets"}/${item.id}`)}
                      >
                        {item.title}
                      </Link>
                      {item.dueAt ? (
                        <span
                          className={`nums text-xs ${new Date(item.dueAt) < new Date(data.now) ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {formatDate(locale, item.dueAt)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {item.kind === "task"
                        ? taskStatusLabel(locale, item.status as TaskStatus)
                        : ticketStatusLabel(locale, item.status as TicketStatus)}
                      {item.context ? ` · ${item.context}` : ""}
                    </p>
                  </li>
                ))}
              </Rows>
              {more(
                data.mine.taskCount + data.mine.ticketCount,
                Math.min(limit, data.mine.items.length),
              )}
            </>
          ) : (
            empty(id)
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            <Link className={`${LINK} text-sm`} to={path("/tasks?assignee=me")}>
              {t("dashboard.home.mine.link")}
            </Link>
            <Link className={`${LINK} text-sm`} to={path("/tickets?assignee=me")}>
              {t("dashboard.home.mine.tickets")}
            </Link>
          </div>
        </>
      );
    return (
      <>
        {data.activity.length ? (
          <Rows>
            {data.activity.slice(0, limit).map((entry) => (
              <li key={entry.id} className="min-w-0 py-3">
                <p className="mb-1 text-xs text-muted-foreground">
                  {actionLabel(locale, entry.action)} · {formatDateTime(locale, entry.occurredAt)}
                </p>
                <Link to={path(entry.href)} className={`${LINK} block`} title={entry.title}>
                  {entry.title}
                </Link>
              </li>
            ))}
          </Rows>
        ) : (
          empty(id)
        )}
        <Link to={path("/changes")} className={`${LINK} mt-3 inline-block text-sm`}>
          {t("dashboard.home.activity.link")}
        </Link>
      </>
    );
  };
  return (
    <div className={mobile ? "space-y-4 p-4" : "space-y-5"}>
      <Customise
        layout={data.layout}
        heading={
          <header>
            <div>
              <h1 className="text-xl font-bold">{t("nav.overview")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.home.subtitle")}</p>
            </div>
          </header>
        }
        entry={
          <Link to={path("/quick-entry")} className={CONTROL}>
            {t("dashboard.quick.entry")}
          </Link>
        }
      />
      {!layout.length ? (
        <p className="text-sm text-muted-foreground">{t("dashboard.home.allHidden")}</p>
      ) : null}
      <div
        className={
          mobile
            ? "grid min-w-0 items-start gap-4"
            : "grid min-w-0 items-start gap-4 lg:grid-cols-2"
        }
      >
        {layout.map((block) => (
          <section
            key={block.id}
            aria-labelledby={`home-${block.id}`}
            data-home-block={block.id}
            data-highlighted={block.mode === "highlight" ? "" : undefined}
            className={`min-w-0 rounded-lg bg-card p-4 shadow-surface-2 ${!mobile && block.mode === "highlight" ? "lg:col-span-2" : ""}`}
          >
            <h2
              id={`home-${block.id}`}
              className={`mb-3 font-semibold ${block.mode === "highlight" ? "text-lg" : "text-base"}`}
            >
              {t(`dashboard.home.${block.id}.title`)}
            </h2>
            {render(block.id, block.mode === "highlight" ? 8 : 3)}
          </section>
        ))}
      </div>
    </div>
  );
}
