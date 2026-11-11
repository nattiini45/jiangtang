import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { getAdminOverview } from "~/domains/admin/overview.queries.server";
import { Badge } from "~/components/ui/badge";
import { toneClassName, toneDotClassName } from "~/lib/status";
import { Check, Circle } from "lucide-react";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return getAdminOverview();
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.overview.meta") }];
}

export default function Overview({
  loaderData: { problems, steps, build, pendingInvitations },
}: Route.ComponentProps) {
  const t = useT();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="type-display">{t("admin.overview.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("admin.overview.subtitle")}</p>
      </div>
      <section aria-labelledby="problems-heading" className="bg-card shadow-surface-2 rounded-lg">
        <h2 id="problems-heading" className="type-subtitle px-4 py-3">
          {t("admin.overview.problems")}
        </h2>
        {problems.length ? (
          <ul>
            {problems.map((problem) => (
              <li key={problem.id} className="py-row flex items-start gap-3 border-t px-4 text-sm">
                <Badge className={toneClassName(problem.severity)}>
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${toneDotClassName(problem.severity)}`}
                  />
                  {t(
                    problem.severity === "fault" ? "admin.overview.broken" : "admin.overview.risk",
                  )}
                </Badge>
                <Link className="min-w-0 underline underline-offset-4" to={problem.href}>
                  {problem.unavailable
                    ? t("admin.overview.unavailable", { check: t(problem.label) })
                    : t(problem.message)}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 border-t px-4 py-3 text-sm">
            <Check aria-hidden className="text-status-operational size-4" />
            {t("admin.overview.clear")}
          </p>
        )}
      </section>
      {steps.length ? (
        <section aria-labelledby="setup-heading">
          <h2 id="setup-heading" className="type-subtitle">
            {t("admin.overview.setup")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("admin.overview.guidance")}</p>
          <ul className="mt-3">
            {steps.map((step) => (
              <li key={step.key} className="py-row flex items-center gap-2 text-sm">
                <Circle aria-hidden className="size-4 shrink-0" />
                <Link className="underline underline-offset-4" to={step.href}>
                  {t(step.key)}
                </Link>
                {step.optional ? <Badge>{t("admin.overview.optional")}</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="glance-heading" className="text-sm">
        <h2 id="glance-heading" className="type-subtitle mb-2">
          {t("admin.overview.glance")}
        </h2>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link to="/admin/about" className="break-all underline underline-offset-4">
            {t("admin.overview.build", {
              version: build.version,
              commit: build.commit === "unknown" ? t("admin.overview.unknownCommit") : build.commit,
            })}
          </Link>
          <Link to="/admin/invitations" className="underline underline-offset-4">
            {pendingInvitations === null
              ? t("admin.overview.invitationsUnknown")
              : t("admin.overview.invitations", { count: pendingInvitations })}
          </Link>
        </div>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
