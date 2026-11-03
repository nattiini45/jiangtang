import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { ProjectStatus } from "~/generated/prisma/enums";
import { listProjects } from "~/domains/projects/projects.queries.server";
import { projectListOptionsSchema } from "~/domains/projects/projects.schema";
import { listUsers } from "~/domains/auth/users.queries.server";
import { parseEnumParam, parseInput } from "~/lib/validation.server";
import { DataGrid } from "~/components/data-grid";
import { projectColumns } from "~/components/projects/project-columns";
import { projectStatusLabel, PROJECT_STATUSES } from "~/components/projects/labels";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { EmptyState } from "~/components/states/empty-state";
import { FolderKanban } from "lucide-react";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/projects` — the project list (the request-for-AV-support lifecycle).
 *
 * **The filters live in the URL and nowhere else**, so a copied link reproduces
 * the view — the `stock` list's contract, reused: `?status=`, `?lead=`, `?q=`,
 * parsed through the domain's own options schema so the list and `listProjects`
 * cannot drift apart. Garbage degrades rather than throws (every field is an
 * optional string).
 *
 * No `requireUser` here: the `_desktop` tree is auth-guarded at
 * `app/routes/_desktop/route.tsx`.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "projects.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const options = parseInput(projectListOptionsSchema, {
    // `parseEnumParam`, not the schema's own z.enum field: a garbage
    // `?status=NOPE` degrades to "unfiltered" instead of throwing a 422 on a
    // shared link (the `?kind=` contract on `/locations`, same helper).
    status: parseEnumParam(ProjectStatus, url.searchParams.get("status")),
    leadId: url.searchParams.get("lead") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  const [projects, leads] = await Promise.all([listProjects(options), listUsers()]);
  return {
    projects,
    leads: leads.filter((u) => u.isActive),
    filters: {
      status: options.status ?? "",
      leadId: options.leadId ?? "",
      q: options.q ?? "",
    },
  };
}

export default function ProjectsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => projectColumns(t), [t]);
  const { projects, leads, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("projects.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("projects.list.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/projects/new">{t("projects.list.new")}</Link>
        </Button>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder={t("projects.list.searchPlaceholder")}
          className="max-w-[16rem]"
          aria-label={t("projects.list.searchAria")}
        />
        <Select
          name="status"
          defaultValue={filters.status}
          className="max-w-[18rem]"
          onChange={autoSubmit}
          aria-label={t("projects.list.filterStatus")}
        >
          <option value="">{t("projects.list.allStatuses")}</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {projectStatusLabel(locale, s)}
            </option>
          ))}
        </Select>
        <Select
          name="lead"
          defaultValue={filters.leadId}
          className="max-w-[18rem]"
          onChange={autoSubmit}
          aria-label={t("projects.list.filterLead")}
        >
          <option value="">{t("projects.list.allLeads")}</option>
          {leads.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        {/* A real button, not a `noscript` one: the selects auto-submit via JS,
            so without a visible submit the filter would be unreachable for
            anyone whose JS has not loaded. */}
        <Button type="submit" variant="tertiary" size="compact">
          {t("projects.list.filterSubmit")}
        </Button>
      </Form>

      <DataGrid
        columns={columns}
        data={projects}
        getRowId={(p) => p.id}
        emptyMessage={
          <EmptyState
            icon={FolderKanban}
            title={t("projects.list.empty")}
            hint={t("projects.list.emptyHint")}
            action={{ to: "/projects/new", label: t("projects.list.emptyAction") }}
            className="border-0"
          />
        }
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
