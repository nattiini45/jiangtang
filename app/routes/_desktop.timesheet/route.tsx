import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { EmptyState } from "~/components/states/empty-state";
import { Timer } from "lucide-react";
import { berlinLocalToUtc } from "~/lib/time.server";
import { berlinLocalString } from "~/lib/berlin-days";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import type { Locale } from "~/i18n/locales";
import { berlinDayIndex, dayIndexToIsoWeek, isoWeekRange } from "~/lib/berlin-days";
import {
  createTimeEntry,
  deleteTimeEntry,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from "~/domains/time/time.mutations.server";
import { getRunningEntry, getWeekTimesheet } from "~/domains/time/time.queries.server";
import {
  timeEntryFormSchema,
  timeEntryIdSchema,
  timerStartSchema,
} from "~/domains/time/time.schema";
import { formatHM } from "~/domains/time/time-utils";
import { listUsers } from "~/domains/auth/users.queries.server";
import { listOpenTaskOptions } from "~/domains/tasks/tasks.queries.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";

/**
 * `/timesheet` — the per-user week grid. `?week=2026-W41` (ISO, Berlin),
 * `?user=` is admin-only (members always see themselves). Cells show the raw
 * per-task minutes; the day/week totals are interval UNIONs — overlapping
 * entries count once, which the column header says out loud.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "timesheet.meta") }];
}

const WEEKDAY_KEYS = [
  "timesheet.weekday.0",
  "timesheet.weekday.1",
  "timesheet.weekday.2",
  "timesheet.weekday.3",
  "timesheet.weekday.4",
  "timesheet.weekday.5",
  "timesheet.weekday.6",
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const url = new URL(request.url);

  const weekParam = url.searchParams.get("week")?.trim();
  const currentWeek = dayIndexToIsoWeek(berlinDayIndex(new Date()));
  let isoWeek = currentWeek;
  if (weekParam) {
    try {
      isoWeekRange(weekParam); // validates the shape
      isoWeek = weekParam;
    } catch {
      isoWeek = currentWeek;
    }
  }

  const isAdmin = actor.role === "ADMIN";
  const users = isAdmin ? await listUsers() : [];
  const userParam = url.searchParams.get("user")?.trim();
  const targetUserId =
    isAdmin && userParam && users.some((u) => u.id === userParam) ? userParam : actor.id;

  const [sheet, running, taskOptions] = await Promise.all([
    getWeekTimesheet(targetUserId, isoWeek),
    getRunningEntry(targetUserId),
    listOpenTaskOptions(""),
  ]);

  const { startDay } = isoWeekRange(isoWeek);
  const prevWeek = dayIndexToIsoWeek(startDay - 7);
  const nextWeek = dayIndexToIsoWeek(startDay + 7);

  return {
    sheet,
    running,
    isoWeek,
    prevWeek,
    nextWeek,
    isAdmin,
    users,
    targetUserId,
    taskOptions,
    todayCol: (() => {
      const today = berlinDayIndex(new Date());
      return today >= startDay && today <= startDay + 6 ? today - startDay : -1;
    })(),
  };
}

/** Berlin `date` + `HH:mm` fields → UTC instants for the domain. */
function formToInstants(
  locale: Locale,
  data: { date: string; startTime: string; endTime?: string },
) {
  const startsAt = berlinLocalToUtc(`${data.date}T${data.startTime}`);
  const endsAt = data.endTime ? berlinLocalToUtc(`${data.date}T${data.endTime}`) : null;
  if (endsAt && endsAt <= startsAt) {
    throw new ValidationError({ endTime: [t(locale, "err.timeEntry.endAfterStart")] });
  }
  return { startsAt, endsAt };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    if (intent === "start-timer") {
      const parsed = safeParse(timerStartSchema, formDataToObject(form), locale);
      const entry = await startTimer(actor, parsed.success ? parsed.data.taskId : undefined);
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "created" });
      return { ok: true as const };
    }
    if (intent === "stop-timer") {
      const entry = await stopTimer(actor);
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "updated" });
      return { ok: true as const };
    }
    if (intent === "delete") {
      const id = safeParse(timeEntryIdSchema, form.get("id"), locale);
      if (!id.success) return { error: t(locale, "err.invalidInput") };
      const entry = await deleteTimeEntry(actor, id.data);
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "deleted" });
      return { ok: true as const };
    }
    if (intent === "add" || intent === "edit") {
      const parsed = safeParse(timeEntryFormSchema, formDataToObject(form), locale);
      if (!parsed.success) {
        return {
          fieldErrors: parsed.fieldErrors,
          error: parsed.formErrors[0] ?? t(locale, "err.invalidInput"),
        };
      }
      const { startsAt, endsAt } = formToInstants(locale, parsed.data);
      const input = {
        startsAt,
        endsAt,
        taskId: parsed.data.taskId,
        comment: parsed.data.comment,
        userId: parsed.data.userId,
      };
      if (intent === "edit" && !parsed.data.id) {
        return { error: t(locale, "err.invalidInput") };
      }
      const entry =
        intent === "add"
          ? await createTimeEntry(actor, input)
          : await updateTimeEntry(actor, parsed.data.id!, input);
      await emitChange({
        entityType: "timeEntry",
        id: entry.id,
        op: intent === "add" ? "created" : "updated",
      });
      return { ok: true as const };
    }
    return { error: t(locale, "err.unknownAction") };
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        error:
          e.formErrors[0] ??
          Object.values(e.fieldErrors).flat()[0] ??
          t(locale, "err.invalidInput"),
        fieldErrors: e.fieldErrors,
      };
    }
    throw toErrorResponse(e);
  }
}

export default function Timesheet({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { sheet, isoWeek, prevWeek, nextWeek, isAdmin, users, targetUserId, running } = loaderData;
  const userParam = isAdmin && targetUserId ? `&user=${targetUserId}` : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("nav.timesheet")}</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link to={`?week=${prevWeek}${userParam}`} className="hover:underline">
            ← {prevWeek}
          </Link>
          <span className="font-mono font-medium">{isoWeek}</span>
          <Link to={`?week=${nextWeek}${userParam}`} className="hover:underline">
            {nextWeek} →
          </Link>
        </div>
      </div>

      {isAdmin ? (
        <Form method="get" className="flex items-center gap-2">
          <input type="hidden" name="week" value={isoWeek} />
          <Select
            name="user"
            defaultValue={targetUserId}
            className="max-w-[16rem]"
            aria-label={t("timesheet.userPickerAria")}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm">
            {t("timesheet.userPickerSubmit")}
          </Button>
        </Form>
      ) : null}

      {running ? (
        <section className="border-border flex items-center gap-3 border p-3">
          <span className="bg-destructive inline-block size-2 animate-pulse rounded-full" />
          <span className="font-mono text-sm">
            {t("timesheet.runningSince", { time: berlinLocalString(running.startsAt).slice(11) })}
            {running.task ? ` — ${running.task.title}` : ""}
          </span>
          <Form method="post">
            <input type="hidden" name="_action" value="stop-timer" />
            <Button type="submit" variant="outline" size="sm">
              {t("shell.timer.stop")}
            </Button>
          </Form>
        </section>
      ) : null}

      {actionData && "error" in actionData && actionData.error ? (
        <p className="text-destructive text-sm" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <section className="border-border overflow-x-auto border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase tracking-wide">
              <th className="p-2">{t("timesheet.col.task")}</th>
              {WEEKDAY_KEYS.map((key, i) => (
                <th
                  key={key}
                  className={`p-2 text-right ${loaderData.todayCol === i ? "text-foreground" : ""}`}
                >
                  {t(key)}
                  <span className="ml-1 font-mono font-normal normal-case">
                    {sheet.dayKeys[i]?.slice(8)}
                  </span>
                </th>
              ))}
              <th className="p-2 text-right">Σ</th>
            </tr>
          </thead>
          <tbody>
            {sheet.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-2">
                  <EmptyState
                    icon={Timer}
                    title={t("timesheet.empty.title")}
                    hint={t("timesheet.empty.hint")}
                    className="border-0"
                  />
                </td>
              </tr>
            ) : (
              sheet.rows.map((row) => (
                <tr key={row.taskId ?? "none"} className="border-border border-t">
                  <td className="p-2">
                    {row.taskId ? (
                      <Link to={`/tasks/${row.taskId}`} className="hover:underline">
                        {row.taskTitle}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{row.taskTitle}</span>
                    )}
                  </td>
                  {row.cells.map((m, i) => (
                    <td key={i} className="p-2 text-right font-mono">
                      {m > 0 ? formatHM(m) : <span className="text-muted-foreground">—</span>}
                    </td>
                  ))}
                  <td className="p-2 text-right font-mono font-medium">{formatHM(row.total)}</td>
                </tr>
              ))
            )}
            <tr className="border-border bg-muted/40 border-t font-medium">
              <td
                className="p-2 text-xs uppercase tracking-wide"
                title={t("timesheet.dayTotalTitle")}
              >
                {t("timesheet.dayTotal")}
              </td>
              {sheet.dayTotals.map((m, i) => (
                <td key={i} className="p-2 text-right font-mono">
                  {m > 0 ? formatHM(m) : "—"}
                </td>
              ))}
              <td className="p-2 text-right font-mono">{formatHM(sheet.weekTotal)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-muted-foreground border-border border-t px-2 py-1 text-xs">
          {t("timesheet.footnote")}
        </p>
      </section>

      <section className="border-border border p-4">
        <h2 className="font-mono text-sm">{t("timesheet.entries.title")}</h2>
        {sheet.entries.length === 0 ? (
          <EmptyState icon={Timer} title={t("timesheet.entries.empty")} className="mt-2" />
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {sheet.entries.map((e) => {
              const local = berlinLocalString(e.startsAt);
              const date = local.slice(0, 10);
              const start = local.slice(11, 16);
              const end = e.endsAt ? berlinLocalString(e.endsAt).slice(11, 16) : "";
              return (
                <li
                  key={e.id}
                  className="border-border flex flex-wrap items-center gap-2 border-b pb-2"
                >
                  <Form method="post" className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="_action" value="edit" />
                    <input type="hidden" name="id" value={e.id} />
                    <input type="hidden" name="taskId" value={e.taskId ?? ""} />
                    <input type="hidden" name="comment" value={e.comment ?? ""} />
                    <Input
                      type="date"
                      name="date"
                      defaultValue={date}
                      className="w-[9rem]"
                      aria-label={t("timesheet.date")}
                    />
                    <Input
                      type="time"
                      name="startTime"
                      defaultValue={start}
                      className="w-[6rem]"
                      aria-label={t("timesheet.startTime")}
                    />
                    <span className="text-muted-foreground">–</span>
                    <Input
                      type="time"
                      name="endTime"
                      defaultValue={end}
                      className="w-[6rem]"
                      aria-label={t("timesheet.endTime")}
                    />
                    <span className="text-muted-foreground min-w-[10rem] flex-1 truncate text-sm">
                      {e.task?.title ?? t("timesheet.noTask")}
                      {e.comment ? ` · ${e.comment}` : ""}
                    </span>
                    <span className="font-mono text-xs">
                      {e.endsAt
                        ? `${formatHM(Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000))} h`
                        : t("timesheet.running")}
                    </span>
                    <Button type="submit" variant="outline" size="sm">
                      {t("common.save")}
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="_action" value="delete" />
                    <input type="hidden" name="id" value={e.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      {t("common.delete")}
                    </Button>
                  </Form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-border border p-4">
        <h2 className="font-mono text-sm">{t("timesheet.add.title")}</h2>
        <Form method="post" className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="_action" value="add" />
          <Input
            type="date"
            name="date"
            required
            className="w-[9rem]"
            aria-label={t("timesheet.date")}
          />
          <Input
            type="time"
            name="startTime"
            required
            className="w-[6rem]"
            aria-label={t("timesheet.startTime")}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            name="endTime"
            className="w-[6rem]"
            aria-label={t("timesheet.endTimeOpen")}
          />
          <Select name="taskId" className="max-w-[18rem]" aria-label={t("timesheet.col.task")}>
            <option value="">{t("timesheet.noTask")}</option>
            {loaderData.taskOptions.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </Select>
          <Input
            name="comment"
            placeholder={t("timesheet.comment")}
            className="min-w-[10rem] flex-1"
            aria-label={t("timesheet.comment")}
          />
          <Button type="submit" size="sm">
            {t("common.add")}
          </Button>
        </Form>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
