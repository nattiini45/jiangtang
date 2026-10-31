import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { createNote } from "~/domains/notes/notes.mutations.server";
import { noteCreateSchema } from "~/domains/notes/notes.schema";
import { getProjectBySlug, listProjectOptions } from "~/domains/projects/projects.queries.server";
import { getLocation, listLocationOptions } from "~/domains/locations/locations.queries.server";
import { ZodForm, FormField } from "~/components/forms";
import { NoteFormErrors } from "~/components/notes/note-form-errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/notes/new` — title plus an optional first paragraph. `?project=<slug>`
 * and `?location=<id>` preselect only when they resolve — a stale link
 * preselects nothing rather than writing against a phantom row. Creation
 * lands on the editor (`/notes/:id`), where the real writing happens.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "notes.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const projectParam = url.searchParams.get("project")?.trim() || undefined;
  const locationParam = url.searchParams.get("location")?.trim() || undefined;

  const [projects, locations, preselectProject, preselectLocation] = await Promise.all([
    listProjectOptions(),
    listLocationOptions(),
    projectParam ? getProjectBySlug(projectParam) : Promise.resolve(null),
    locationParam ? getLocation(locationParam) : Promise.resolve(null),
  ]);

  return {
    projects,
    locations,
    defaults: {
      projectId: preselectProject?.id ?? undefined,
      locationId: preselectLocation?.id ?? undefined,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, noteCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  try {
    const note = await createNote(actor, result.data);
    await emitChange({ entityType: "note", id: note.id, op: "created" });
    return redirect(`/notes/${note.id}`);
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    throw toErrorResponse(e);
  }
}

export default function NoteNew({ loaderData, actionData }: Route.ComponentProps) {
  const { projects, locations, defaults } = loaderData;
  const t = useT();
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("notes.new.title")}</h1>
        <Link to="/notes" className="text-muted-foreground text-sm hover:underline">
          {t("notes.new.back")}
        </Link>
      </div>
      <NoteFormErrors formErrors={actionData?.formErrors} />
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <FormField name="title" label={t("notes.new.titleLabel")}>
          <Input name="title" required />
        </FormField>
        <FormField name="body" label={t("notes.new.bodyLabel")}>
          <Textarea name="body" rows={6} className="font-mono" />
        </FormField>
        <FormField name="projectId" label={t("notes.new.projectLabel")}>
          <Select name="projectId" defaultValue={defaults.projectId ?? ""}>
            <option value="">{t("notes.new.noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField name="locationId" label={t("notes.new.locationLabel")}>
          <Select name="locationId" defaultValue={defaults.locationId ?? ""}>
            <option value="">{t("notes.new.noLocation")}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="submit">{t("notes.new.submit")}</Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
