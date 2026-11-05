import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { getProjectBySlug, listProjectOptions } from "~/domains/projects/projects.queries.server";
import { projectEditSchema } from "~/domains/projects/projects.schema";
import { deleteProject, updateProject } from "~/domains/projects/projects.mutations.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { ZodForm } from "~/components/forms";
import { ProjectFormFields } from "~/components/projects/project-form-fields";
import { ProjectFormErrors } from "~/components/projects/project-form-errors";
import { Button } from "~/components/ui/button";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/projects/:slug/edit` — edit + delete, two intents through one action
 * (`update` · `delete`), the locations edit route's convention.
 *
 * A refusal is a returned value, never a throw: `updateProject` refusing a
 * reparent into the project's own subtree and `deleteProject` refusing a
 * project that still has sub-projects come back as `ValidationError` and are
 * rendered via `{ fieldErrors, formErrors }`.
 *
 * The parent picker lists every OTHER project including this one's descendants,
 * because refusing a move into your own subtree is the case the guard exists to
 * refuse — hiding the impossible choices would make it unreachable from the UI.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "projects.meta.edit", {
        name: data?.project.name ?? t(locale, "projects.meta.fallbackName"),
      }),
    },
  ];
}

/** `Date | null` → the `yyyy-mm-dd` an `<input type="date">` needs, in Europe/Berlin. */
function dateInputValue(d: Date | null | undefined): string | null {
  if (!d) return null;
  // `en-CA` is the ISO-shaped `yyyy-mm-dd` locale, and the timeZone is pinned:
  // without it a UTC-midnight date renders as the PREVIOUS day in a Berlin-local
  // browser (the stock route's lesson).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const project = await getProjectBySlug(params.slug);
  if (!project) throw toErrorResponse(new NotFoundError(t(locale, "err.project.notFound")));
  const [parents, users] = await Promise.all([listProjectOptions(), listUsers()]);
  return {
    project,
    parents: parents.filter((p) => p.id !== project.id),
    leads: users.filter((u) => u.isActive),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");

  const project = await getProjectBySlug(params.slug);
  if (!project) throw toErrorResponse(new NotFoundError(t(locale, "err.project.notFound")));

  try {
    if (intent === "delete") {
      await deleteProject(actor, project.id);
      await emitChange({ entityType: "project", id: project.id, op: "deleted" });
      return redirect("/projects");
    }
    if (intent !== "update") {
      return { fieldErrors: {}, formErrors: [t(locale, "err.unknownAction")] };
    }
    const result = safeParse(
      projectEditSchema,
      { ...formDataToObject(form), id: project.id },
      locale,
    );
    if (!result.success) {
      return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
    }
    const updated = await updateProject(actor, project.id, result.data);
    await emitChange({ entityType: "project", id: updated.id, op: "updated" });
    return redirect(`/projects/${project.slug}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function EditProject({ loaderData, actionData }: Route.ComponentProps) {
  const { project, parents, leads } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("projects.edit.title", { name: project.name })}</h1>
        <Link
          to={`/projects/${project.slug}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          {t("projects.edit.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <ProjectFormErrors formErrors={actionData?.formErrors} />
        {/* No `status` control on purpose: a transition is `setProjectStatus` on
            the detail page, audited `ProjectStatusChanged` — not a save. */}
        <ProjectFormFields
          leads={leads}
          parents={parents}
          defaults={{
            name: project.name,
            description: project.description,
            color: project.color,
            startAt: dateInputValue(project.startAt),
            dueAt: dateInputValue(project.dueAt),
            leadId: project.leadId,
            parentProjectId: project.parentProjectId,
          }}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t("common.saving") : t("projects.edit.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to={`/projects/${project.slug}`}>{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>

      <Form
        method="post"
        className="border-border mt-6 border-t pt-4"
        onSubmit={(e) => {
          if (!confirm(t("projects.edit.confirmDelete", { name: project.name })))
            e.preventDefault();
        }}
      >
        <input type="hidden" name="_action" value="delete" />
        <Button type="submit" variant="destructive" disabled={busy}>
          {t("projects.edit.delete")}
        </Button>
        <p className="text-muted-foreground mt-1 text-xs">{t("projects.edit.deleteHint")}</p>
      </Form>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
