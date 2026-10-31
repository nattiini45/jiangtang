import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { taskCreateSchema } from "~/domains/tasks/tasks.schema";
import { listProjectOptions, getProjectBySlug } from "~/domains/projects/projects.queries.server";
import { getTask, listOpenTaskOptions } from "~/domains/tasks/tasks.queries.server";
import { listLocationOptions } from "~/domains/locations/locations.queries.server";
import { ZodForm } from "~/components/forms";
import { TaskFormFields } from "~/components/tasks/task-form-fields";
import { TaskFormErrors } from "~/components/tasks/task-form-errors";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/tasks/new` — create a task. The new card lands at the END of its
 * status's lane (`createTask`'s rule). `?project=<slug>` and `?parent=<id>`
 * preselect the pickers ONLY when they resolve — a stale link preselects
 * nothing rather than writing against a phantom row.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "tasks.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const projectParam = url.searchParams.get("project")?.trim() || undefined;
  const parentParam = url.searchParams.get("parent")?.trim() || undefined;

  const [projects, parents, locations, preselectProject, preselectParent] = await Promise.all([
    listProjectOptions(),
    listOpenTaskOptions(""),
    listLocationOptions(),
    projectParam ? getProjectBySlug(projectParam) : Promise.resolve(null),
    parentParam ? getTask(parentParam) : Promise.resolve(null),
  ]);

  return {
    projects,
    parents: parents.map((t) => ({ id: t.id, name: t.title })),
    locations,
    defaults: {
      projectId: preselectProject?.id ?? undefined,
      parentTaskId: preselectParent?.id ?? undefined,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, taskCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  try {
    const task = await createTask(actor, result.data);
    await emitChange({ entityType: "task", id: task.id, op: "created" });
    return redirect(`/tasks/${task.id}`);
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    throw toErrorResponse(e);
  }
}

export default function TaskNew({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { projects, parents, locations, defaults } = loaderData;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("tasks.new.title")}</h1>
        <Link to="/tasks" className="text-muted-foreground text-sm hover:underline">
          {t("tasks.new.back")}
        </Link>
      </div>
      <TaskFormErrors formErrors={actionData?.formErrors} />
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <TaskFormFields
          defaults={defaults}
          projects={projects}
          parents={parents}
          locations={locations}
          includeStatus
          titleAutoFocus
        />
        <Button type="submit">{t("tasks.new.submit")}</Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
