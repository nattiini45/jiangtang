import { Link, redirect, useNavigate } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { taskCreateSchema } from "~/domains/tasks/tasks.schema";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { listProjects } from "~/domains/projects/projects.queries.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { CAPTURE_HEADER } from "~/lib/pwa/offline-queue";
import { CaptureQueueStatus, useCaptureSubmit } from "~/components/mobile/capture-form";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

/**
 * Mobile task capture — title + optional project + optional due day.
 * The client intercepts the submit (`CaptureSubmit`); offline it queues and
 * replays, and the `clientId` it mints becomes the task's own id, so a replay
 * after a flaky-but-successful first send cannot double the row.
 *
 * The action answers the capture header with `{ id }` JSON; a plain form post
 * gets the normal redirect to the new task.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "mobile.meta.taskNew") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const projects = await listProjects({});
  return { projects };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const wantsJson = request.headers.get(CAPTURE_HEADER) === "1";
  const obj = formDataToObject(await request.formData());
  const { clientId, ...rest } = obj;
  const parsed = safeParse(taskCreateSchema, rest, locale);
  try {
    if (!parsed.success) {
      throw new ValidationError(parsed.fieldErrors, parsed.formErrors);
    }
    const task = await createTask(
      actor,
      parsed.data,
      [],
      typeof clientId === "string" && clientId !== "" ? clientId : undefined,
    );
    await emitChange({ entityType: "task", id: task.id, op: "created" });
    if (wantsJson) return Response.json({ id: task.id });
    return redirect(`/m/tasks/${task.id}`);
  } catch (e) {
    if (wantsJson && e instanceof ValidationError) {
      const msg = [...e.formErrors, ...Object.values(e.fieldErrors).flat()].join(" · ");
      return Response.json({ error: msg || t(locale, "err.invalidInput") }, { status: 400 });
    }
    throw toErrorResponse(e);
  }
}

export default function MobileTaskNew({ loaderData }: Route.ComponentProps) {
  const { projects } = loaderData;
  const tr = useT();
  const navigate = useNavigate();
  const { state, error, submit } = useCaptureSubmit("/m/tasks/new");

  return (
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <Link to="/m/tasks" className="text-muted-foreground font-mono text-xs">
          {tr("mobile.tasks.back")}
        </Link>
        <h1 className="mt-1 font-mono text-lg">{tr("mobile.tasks.create")}</h1>
      </div>

      <form
        className="space-y-4 px-4 py-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await submit(e.currentTarget);
          if (result?.state === "sent") {
            void navigate(result.id ? `/m/tasks/${result.id}` : "/m/tasks");
          }
        }}
      >
        <div>
          <label htmlFor="title" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.capture.fieldTitle")}
          </label>
          <input
            id="title"
            name="title"
            required
            autoFocus
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          />
        </div>

        <div>
          <label htmlFor="projectId" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.tasks.project")}
          </label>
          <select
            id="projectId"
            name="projectId"
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          >
            <option value="">{tr("mobile.tasks.noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="dueAt" className="text-muted-foreground mb-1 block font-mono text-xs">
            {tr("mobile.tasks.dueOn")}
          </label>
          <input
            id="dueAt"
            name="dueAt"
            type="date"
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          />
        </div>

        {state === "queued" ? (
          <p role="status" className="text-sm">
            {tr("mobile.capture.queued")}
          </p>
        ) : null}
        {state === "refused" && error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={state === "sending"}
          className="bg-primary text-primary-foreground flex min-h-11 w-full items-center justify-center rounded-sm text-base disabled:opacity-60"
        >
          {state === "sending" ? tr("mobile.capture.saving") : tr("mobile.capture.create")}
        </button>
      </form>

      <div className="px-4 pb-4">
        <CaptureQueueStatus url="/m/tasks/new" />
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
