import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { projectCreateSchema } from "~/domains/projects/projects.schema";
import { createProject } from "~/domains/projects/projects.mutations.server";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { ZodForm } from "~/components/forms";
import { ProjectFormFields } from "~/components/projects/project-form-fields";
import { ProjectFormErrors } from "~/components/projects/project-form-errors";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/projects/new` — create a project through `createProject`. The slug
 * is derived from the name and never offered as a field: it is the URL, so it
 * must be generated, and it stays stable across renames.
 *
 * `?parent=<id>` preselects a parent project — honoured only when the id
 * resolves (the locations route's convention: a stale value must not silently
 * create at the root).
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "projects.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const [parents, users] = await Promise.all([listProjectOptions(), listUsers()]);
  const requested = new URL(request.url).searchParams.get("parent");
  const defaultParentId = parents.some((p) => p.id === requested) ? requested : null;
  return { parents, leads: users.filter((u) => u.isActive), defaultParentId };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, projectCreateSchema);
  if (!result.success) {
    return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  }
  try {
    const project = await createProject(actor, result.data);
    await emitChange({ entityType: "project", id: project.id, op: "created" });
    return redirect(`/projects/${project.slug}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function NewProject({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("projects.new.title")}</h1>
        <Link to="/projects" className="text-muted-foreground text-sm hover:underline">
          {t("projects.new.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <ProjectFormErrors formErrors={actionData?.formErrors} />
        <ProjectFormFields
          includeStatus
          leads={loaderData.leads}
          parents={loaderData.parents}
          defaults={{ parentProjectId: loaderData.defaultParentId }}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t("common.creating") : t("projects.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/projects">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
