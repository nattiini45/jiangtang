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
import { formatDate } from "~/i18n/format";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { MobileRouteErrorBoundary as RouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
import { cn } from "~/lib/utils";
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
  if (!task) throw toErrorResponse(new NotFoundError(t(locale, "err.task.notFound")));
  return { task, meId: user.id };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const task = await getTask(params.id);
  if (!task) throw toErrorResponse(new NotFoundError(t(locale, "err.task.notFound")));
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
  TaskStatus.BLOCKED,
  TaskStatus.DONE,
];

export default function MobileTaskDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { task, meId } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const iAmAssigned = task.assignees.some((a) => a.user.id === meId);

  return (
    <div className="flex flex-col gap-6 px-4 py-4">
      <div className="flex flex-col gap-1">
        <Link to="/m/tasks" className="text-muted-foreground flex min-h-11 items-center text-sm">
          {t(locale, "mobile.tasks.back")}
        </Link>
        <h1 className="text-lg leading-snug font-semibold">{task.title}</h1>
        <p className="text-muted-foreground nums text-xs">
          {[
            taskStatusLabel(locale, task.status),
            task.project?.name ?? null,
            task.dueAt
              ? t(locale, "mobile.tasks.due", { date: formatDate(locale, task.dueAt) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {task.body ? (
        <section className="bg-card shadow-surface-2 rounded-lg p-3">
          <p className="text-sm whitespace-pre-wrap">{task.body}</p>
        </section>
      ) : null}

      <section className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-3">
        <p className="text-muted-foreground text-xs">{t(locale, "mobile.tasks.assigned")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {task.assignees.length === 0 ? (
            <span className="text-muted-foreground text-sm">
              {t(locale, "mobile.tasks.nobody")}
            </span>
          ) : (
            task.assignees.map((a) => (
              <Badge key={a.user.id}>{a.user.initials ?? a.user.name}</Badge>
            ))
          )}
          <Form method="post" className="ml-auto">
            <input type="hidden" name="_action" value="assign-me" />
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || iAmAssigned}
              className="min-h-11"
            >
              {iAmAssigned
                ? t(locale, "mobile.tasks.assigned")
                : t(locale, "mobile.tasks.assignMe")}
            </Button>
          </Form>
        </div>
      </section>

      <section className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-3">
        <p className="text-muted-foreground text-xs">{t(locale, "mobile.tasks.setStatus")}</p>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_STATUSES.map((s) => (
            <Form key={s} method="post">
              <input type="hidden" name="_action" value="set-status" />
              <input type="hidden" name="status" value={s} />
              <Button
                type="submit"
                variant={task.status === s ? "primary" : "secondary"}
                disabled={busy || task.status === s}
                className={cn("min-h-11 w-full", task.status === s && "disabled:opacity-100")}
              >
                {taskStatusLabel(locale, s)}
              </Button>
            </Form>
          ))}
        </div>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
