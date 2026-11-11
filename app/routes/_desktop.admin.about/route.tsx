import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { buildInfo } from "~/lib/version.server";
import { environmentStatus } from "~/lib/environment.server";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return { build: buildInfo, variables: environmentStatus() };
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.about.meta") }];
}

export default function About({ loaderData: { build, variables } }: Route.ComponentProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="type-display">{t("nav.about")}</h1>
        <p className="text-muted-foreground text-sm">{t("admin.about.subtitle")}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("admin.about.version")}</dt>
        <dd>{build.version}</dd>
        <dt className="text-muted-foreground">{t("admin.about.commit")}</dt>
        <dd className="break-all">
          {build.commit === "unknown" ? t("admin.about.commitMissing") : build.commit}
        </dd>
      </dl>
      <section className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
        <div className="border-b px-4 py-3">
          <h2 className="type-subtitle">{t("admin.about.environment")}</h2>
          <p className="text-muted-foreground text-sm">{t("admin.about.presenceOnly")}</p>
        </div>
        <table className="w-full table-fixed text-left text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr className="border-b">
              <th scope="col" className="w-3/5 px-4 py-2">
                {t("admin.about.variable")}
              </th>
              <th scope="col" className="px-4 py-2">
                {t("admin.about.status")}
              </th>
            </tr>
          </thead>
          {Array.from(new Set(variables.map((v) => v.group))).map((group) => (
            <tbody key={group}>
              <tr className="bg-tint border-b">
                <th scope="rowgroup" colSpan={2} className="px-4 py-2 font-semibold">
                  {t(`admin.about.group.${group}`)}
                </th>
              </tr>
              {variables
                .filter((v) => v.group === group)
                .map((variable) => (
                  <tr key={variable.name} className="border-b last:border-b-0">
                    <th scope="row" className="py-row px-4 font-normal">
                      <code className="break-all text-xs">{variable.name}</code>
                    </th>
                    <td className="py-row px-4">
                      {t(variable.set ? "admin.about.set" : "admin.about.notSet")}
                      {variable.set && variable.expectedUnset ? (
                        <p className="text-destructive text-xs">
                          {t("admin.about.removeBootstrap")}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
