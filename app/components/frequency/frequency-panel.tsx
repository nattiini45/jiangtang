import type { FrequencyGroup } from "~/domains/inventory/inventory.frequency.server";
import { FrequencyBoard } from "~/components/frequency/frequency-board";
import { useT } from "~/i18n/use-t";

/**
 * The frequency-coordination panel of the `/inventory` tabs. `/frequencies`
 * used to be its own page; it now redirects to `/inventory?tab=frequencies`.
 */
export function FrequencyPanel({ groups }: { groups: FrequencyGroup[] }) {
  const t = useT();
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
