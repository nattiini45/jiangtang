import { ViewSwitch } from "~/components/layout/view-switch";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listProjects } from "~/domains/projects/projects.queries.server";
import { projectStatusLabel } from "~/components/projects/labels";
import { EmptyState } from "~/components/states/empty-state";
import { FolderKanban } from "lucide-react";
import { MobileRouteErrorBoundary as RouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile projects list — read-only reuse of the desktop list query. Rows tap
 * through to the (desktop) project page; there is no mobile project detail yet.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.projects") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const projects = await listProjects();
  return { projects };
}

export default function MobileProjectsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { projects } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.projects")}</h1>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {projects.map((p) => (
          <li key={p.id}>
            <ViewSwitch
              view="desktop"
              desktopLabel
              next={`/projects/${p.slug}`}
              className="active:bg-selected flex min-h-12 w-full flex-col justify-center gap-0.5 px-3 py-2 text-left transition-colors duration-80"
            >
              <span className="whitespace-normal text-sm font-semibold">{p.name}</span>
              <span className="text-muted-foreground whitespace-normal text-xs">
                {[
                  projectStatusLabel(locale, p.status),
                  p.lead?.name ?? null,
                  t("mobile.projects.tasks", { open: p.tasks.open, total: p.tasks.total }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </ViewSwitch>
          </li>
        ))}
        {projects.length === 0 ? (
          <li>
            <EmptyState
              icon={FolderKanban}
              title={t("mobile.projects.empty")}
              hint={t("mobile.projects.emptyHint")}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
