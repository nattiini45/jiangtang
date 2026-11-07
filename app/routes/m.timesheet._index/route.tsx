import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { resolveLocale } from "~/i18n/locale.server";
import { timerStartSchema } from "~/domains/time/time.schema";
import { startTimer, stopTimer } from "~/domains/time/time.mutations.server";
import { getRunningEntry, getWeekTimesheet } from "~/domains/time/time.queries.server";
import { listOpenTaskOptions } from "~/domains/tasks/tasks.queries.server";
import { formatHM } from "~/domains/time/time-utils";
import {
  berlinLocalString,
  berlinDayIndex,
  dayIndexToIsoWeek,
  isoWeekRange,
} from "~/lib/berlin-days";
import { EmptyState } from "~/components/states/empty-state";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { Timer } from "lucide-react";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Mobile timesheet — the current ISO week (Berlin) plus a start/stop timer.
 * Reuses the desktop read queries and timer mutations; the action only
 * dispatches `start-timer` / `stop-timer`, the same intents as `/timesheet`.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.timesheet") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const weekParam = url.searchParams.get("week")?.trim();
  const currentWeek = dayIndexToIsoWeek(berlinDayIndex(new Date()));
  let isoWeek = currentWeek;
  if (weekParam) {
    try {
      isoWeekRange(weekParam);
      isoWeek = weekParam;
    } catch {
      isoWeek = currentWeek;
    }
  }
  const [sheet, running, taskOptions] = await Promise.all([
    getWeekTimesheet(user.id, isoWeek),
    getRunningEntry(user.id),
    listOpenTaskOptions(""),
  ]);
  const { startDay } = isoWeekRange(isoWeek);
  return {
    sheet,
    running,
    isoWeek,
    prevWeek: dayIndexToIsoWeek(startDay - 7),
    nextWeek: dayIndexToIsoWeek(startDay + 7),
    taskOptions,
  };
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
    return { error: translate(locale, "err.unknownAction") };
  } catch (e) {
    if (e instanceof ValidationError) {
      return { error: e.formErrors[0] ?? translate(locale, "err.invalidInput") };
    }
    throw toErrorResponse(e);
  }
}

export default function MobileTimesheet({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { sheet, isoWeek, prevWeek, nextWeek, running, taskOptions } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.timesheet")}</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link to={`/m/timesheet?week=${prevWeek}`} className="hover:underline">
            ← {prevWeek}
          </Link>
          <span className="nums font-semibold">{isoWeek}</span>
          <Link to={`/m/timesheet?week=${nextWeek}`} className="hover:underline">
            {nextWeek} →
          </Link>
        </div>
      </div>

      {running ? (
        <section className="bg-card shadow-surface-2 flex flex-wrap items-center gap-3 rounded-lg p-4">
          <span className="bg-destructive inline-block size-2 animate-pulse rounded-full" />
          <span className="nums text-sm">
            {t("mobile.timesheet.runningSince", {
              time: berlinLocalString(running.startsAt).slice(11, 16),
            })}
            {running.task ? ` — ${running.task.title}` : ""}
          </span>
          <Form method="post" className="ml-auto">
            <input type="hidden" name="_action" value="stop-timer" />
            <Button type="submit" variant="secondary" className="min-h-11">
              {t("shell.timer.stop")}
            </Button>
          </Form>
        </section>
      ) : (
        <Form
          method="post"
          className="bg-card shadow-surface-2 flex flex-wrap items-center gap-2 rounded-lg p-4"
        >
          <input type="hidden" name="_action" value="start-timer" />
          <Select
            name="taskId"
            className="max-w-[16rem] flex-1"
            aria-label={t("timesheet.col.task")}
          >
            <option value="">{t("timesheet.noTask")}</option>
            {taskOptions.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </Select>
          <Button type="submit" className="min-h-11">
            {t("mobile.timesheet.start")}
          </Button>
        </Form>
      )}

      {actionData && "error" in actionData && actionData.error ? (
        <p className="text-destructive text-sm" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <section className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
        <ul className="divide-y">
          {sheet.entries.length === 0 ? (
            <li>
              <EmptyState icon={Timer} title={t("mobile.timesheet.empty")} />
            </li>
          ) : (
            sheet.entries.map((e) => {
              const local = berlinLocalString(e.startsAt);
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="nums text-xs">{local.slice(5, 10)}</span>
                  <span className="nums text-xs">
                    {local.slice(11, 16)}–
                    {e.endsAt ? berlinLocalString(e.endsAt).slice(11, 16) : t("timesheet.running")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {e.task?.title ?? t("timesheet.noTask")}
                  </span>
                  <span className="nums text-xs font-semibold">
                    {e.endsAt
                      ? formatHM(Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000))
                      : "—"}
                  </span>
                </li>
              );
            })
          )}
        </ul>
        <p className="bg-tint nums px-3 py-2 text-right text-xs font-semibold">
          {t("mobile.timesheet.weekTotal", { hours: formatHM(sheet.weekTotal) })}
        </p>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
