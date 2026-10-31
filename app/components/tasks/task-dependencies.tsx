import { Form, Link } from "react-router";
import { StatusCell } from "~/components/data-grid";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import type { TaskStatus } from "~/generated/prisma/client";
import { useT } from "~/i18n/use-t";

export interface TaskLink {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface TaskOption {
  id: string;
  title: string;
}

/**
 * The dependency panel on `/tasks/:id`: "Blockiert durch" lists the
 * tasks THIS one waits on (remove buttons + an add-select of open tasks, self
 * excluded by the caller's option list); "Blockiert" lists what waits on this
 * one. A cycle refusal comes back as a `formErrors` entry — the route renders
 * it through `TaskFormErrors`, not here.
 */
export function TaskDependencies({
  taskId,
  blockers,
  blockedTasks,
  options,
  fieldError,
  busy,
}: {
  taskId: string;
  /** Tasks blocking this one (`blockedBy` edges). */
  blockers: TaskLink[];
  /** Tasks this one blocks (`blocking` edges). */
  blockedTasks: TaskLink[];
  /** Open tasks offered in the add-select. */
  options: TaskOption[];
  /** `fieldErrors.blockerTaskId[0]` — the self-edge/duplicate refusals (a cycle is a formError, shown by the page). */
  fieldError?: string;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {t("tasks.deps.blockedBy")}
        </p>
        {blockers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("tasks.deps.none")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {blockers.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <Form method="post">
                  <input type="hidden" name="_action" value="blocker-remove" />
                  <input type="hidden" name="blockerTaskId" value={b.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={t("tasks.deps.removeAria", { title: b.title })}
                  >
                    ×
                  </Button>
                </Form>
                <Link to={`/tasks/${b.id}`} className="hover:underline">
                  {b.title}
                </Link>
                <StatusCell kind="task" value={b.status} />
              </li>
            ))}
          </ul>
        )}
        <Form method="post" className="flex items-center gap-2">
          <input type="hidden" name="_action" value="blocker-add" />
          <input type="hidden" name="taskId" value={taskId} />
          <Select
            name="blockerTaskId"
            required
            className="max-w-[24rem]"
            aria-label={t("tasks.deps.pickAria")}
          >
            <option value="">{t("tasks.deps.pickPlaceholder")}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {t("tasks.deps.add")}
          </Button>
        </Form>
        {fieldError ? (
          <p className="text-destructive text-xs" role="alert">
            {fieldError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {t("tasks.deps.blocks")}
        </p>
        {blockedTasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("tasks.deps.blocksNone")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {blockedTasks.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <Link to={`/tasks/${b.id}`} className="hover:underline">
                  {b.title}
                </Link>
                <StatusCell kind="task" value={b.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
