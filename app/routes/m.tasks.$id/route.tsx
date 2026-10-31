import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { getTask } from "~/domains/tasks/tasks.queries.server";
import { setTaskAssignees, setTaskStatus } from "~/domains/tasks/tasks.mutations.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { TaskStatus } from "~/generated/prisma/enums";
import { taskStatusLabel } from "~/components/tasks/labels";
import { berlinDateInput } from "~/lib/format-date";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { metaLocale } from "~/i18n/meta";
import { useLocale } from "~/i18n/use-t";

/**
 * Mobile task detail — the field-technician view: read the card, tap a
 * status button or "assign to me". Same intents as the desktop detail action,
 * same domain mutations — a phone in a machine room does not get a weaker
 * audit trail.
 */
export function meta({ loaderData, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  const name = loaderData?.task.title ?? t(locale, "tasks.meta.fallbackName");
  return [{ title: t(locale, "tasks.meta.detail", { name }) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const locale = resolveLocale(request);
  const task = await getTask(params.id);
  if (!task) throw new NotFoundError(t(locale, "err.task.notFound"));
  return { task, meId: user.id };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const task = await getTask(params.id);
  if (!task) throw new NotFoundError(t(locale, "err.task.notFound"));
  try {
    if (intent === "set-status") {
      const status = String(form.get("status") ?? "") as TaskStatus;
      if (!Object.values(TaskStatus).includes(status)) {
        throw new ValidationError({ status: [t(locale, "err.unknownStatus")] });
      }
      await setTaskStatus(actor, params.id, status);
    } else if (intent === "assign-me") {
      // Append the actor, keep the others — same semantics as the palette verb.
      const next = task.assignees.map((a) => ({
        userId: a.user.id,
        estimateMinutes: a.estimateMinutes ?? undefined,
      }));
      if (!next.some((a) => a.userId === actor.id)) {
        next.push({ userId: actor.id!, estimateMinutes: undefined });
      }
      await setTaskAssignees(actor, params.id, next);
    } else {
      throw new ValidationError({}, [t(locale, "err.unknownAction")]);
    }
    await emitChange({ entityType: "task", id: params.id, op: "updated" });
    return { ok: true };
  } catch (e) {
    throw toErrorResponse(e);
  }
}

const QUICK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.DONE,
];

export default function MobileTaskDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { task, meId } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const iAmAssigned = task.assignees.some((a) => a.user.id === meId);

  return (
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <Link to="/m/tasks" className="text-muted-foreground font-mono text-xs">
          {t(locale, "mobile.tasks.back")}
        </Link>
        <h1 className="mt-1 text-lg leading-snug">{task.title}</h1>
        <p className="text-muted-foreground font-mono text-xs">
          {[
            taskStatusLabel(locale, task.status),
            task.project?.name ?? null,
            task.dueAt
              ? t(locale, "mobile.tasks.due", { date: berlinDateInput(task.dueAt) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {task.body ? (
        <p className="border-border whitespace-pre-wrap border-b px-4 py-3 text-sm">{task.body}</p>
      ) : null}

      <div className="border-border border-b px-4 py-3">
        <div className="text-muted-foreground mb-2 font-mono text-xs">
          {t(locale, "mobile.tasks.assigned")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {task.assignees.length === 0 ? (
            <span className="text-muted-foreground text-sm">
              {t(locale, "mobile.tasks.nobody")}
            </span>
          ) : (
            task.assignees.map((a) => (
              <span key={a.user.id} className="border-border rounded-sm border px-2 py-1 text-xs">
                {a.user.initials ?? a.user.name}
              </span>
            ))
          )}
          <Form method="post" className="ml-auto">
            <input type="hidden" name="_action" value="assign-me" />
            <button
              type="submit"
              disabled={busy || iAmAssigned}
              className="border-border flex min-h-11 items-center rounded-sm border px-3 text-sm disabled:opacity-50"
            >
              {iAmAssigned
                ? t(locale, "mobile.tasks.assigned")
                : t(locale, "mobile.tasks.assignMe")}
            </button>
          </Form>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="text-muted-foreground mb-2 font-mono text-xs">
          {t(locale, "mobile.tasks.setStatus")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_STATUSES.map((s) => (
            <Form key={s} method="post">
              <input type="hidden" name="_action" value="set-status" />
              <input type="hidden" name="status" value={s} />
              <button
                type="submit"
                disabled={busy || task.status === s}
                className={
                  task.status === s
                    ? "bg-primary text-primary-foreground flex min-h-11 w-full items-center justify-center rounded-sm text-sm"
                    : "border-border flex min-h-11 w-full items-center justify-center rounded-sm border text-sm"
                }
              >
                {taskStatusLabel(locale, s)}
              </button>
            </Form>
          ))}
        </div>
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
