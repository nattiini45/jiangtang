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
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
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
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-col gap-1">
        <Link to="/m/tasks" className="text-muted-foreground flex min-h-11 items-center text-sm">
          {tr("mobile.tasks.back")}
        </Link>
        <h1 className="text-lg font-semibold">{tr("mobile.tasks.create")}</h1>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          // React clears currentTarget once the handler yields, so keep the form.
          const form = e.currentTarget;
          const result = await submit(form);
          if (result?.state === "sent") {
            void navigate(result.id ? `/m/tasks/${result.id}` : "/m/tasks");
          } else if (result?.state === "queued") {
            // The capture is stored and listed below; a filled form invites a second tap,
            // which would queue the same capture again under a new id.
            form.reset();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">{tr("mobile.capture.fieldTitle")}</Label>
          <Input id="title" name="title" required autoFocus className="min-h-11" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projectId">{tr("mobile.tasks.project")}</Label>
          <Select id="projectId" name="projectId" className="[&>select]:h-11">
            <option value="">{tr("mobile.tasks.noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dueAt">{tr("mobile.tasks.dueOn")}</Label>
          <Input id="dueAt" name="dueAt" type="date" className="min-h-11" />
        </div>

        {state === "queued" || state === "signin" ? (
          <p role="status" className="bg-status-warning/15 rounded-md px-3 py-2 text-sm">
            {tr(state === "signin" ? "mobile.capture.queuedSignIn" : "mobile.capture.queued")}
          </p>
        ) : null}
        {state === "refused" && error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={state === "sending"} className="min-h-11 w-full">
          {state === "sending" ? tr("mobile.capture.saving") : tr("mobile.capture.create")}
        </Button>
      </form>

      <CaptureQueueStatus url="/m/tasks/new" />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
