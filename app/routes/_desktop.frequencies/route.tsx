import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listFrequencyBoard } from "~/domains/inventory/inventory.frequency.server";
import { FrequencyBoard } from "~/components/frequency/frequency-board";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "frequency.meta.title") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const groups = await listFrequencyBoard();
  return { groups };
}

export default function Frequencies({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { groups } = loaderData;
  const totalClashes = groups.reduce((sum, g) => sum + g.clashCount, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold">{t("frequency.title")}</h1>
        <p className="text-muted-foreground text-sm">
          {t("frequency.subtitle.prefix")}{" "}
          <span className={totalClashes > 0 ? "text-status-fault" : undefined}>
            {t("frequency.subtitle.clash")}
          </span>
          .
        </p>
      </div>

      <FrequencyBoard groups={groups} />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
