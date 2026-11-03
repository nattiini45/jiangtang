import { StatusBadge } from "~/components/ui/status-badge";
import { micKindLabel } from "~/components/inventory/labels";
import { useLocale, useT } from "~/i18n/use-t";
import { cn } from "~/lib/utils";
import type { FrequencyGroup } from "~/domains/inventory/inventory.frequency.server";

/** Read-only frequency coordination board. Groups wireless units by building and
 * highlights units that clash on the same frequency inside one building. */

function Dash() {
  return <span className="text-muted-foreground">–</span>;
}

export function FrequencyBoard({ groups }: { groups: FrequencyGroup[] }) {
  const t = useT();
  if (groups.length === 0) {
    return (
      <div className="bg-card shadow-surface-2 text-muted-foreground rounded-lg p-8 text-center text-sm">
        {t("frequency.empty")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <BuildingSection key={group.key} group={group} />
      ))}
    </div>
  );
}

function BuildingSection({ group }: { group: FrequencyGroup }) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="bg-card shadow-surface-2 rounded-lg">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="text-base font-semibold">
          {group.campusName ? (
            <>
              <span className="text-muted-foreground">{group.campusName}</span>
              <span className="text-muted-foreground"> · </span>
            </>
          ) : null}
          <span>{group.buildingName}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          {group.frequencyCount}{" "}
          {t(group.frequencyCount === 1 ? "frequency.count.one" : "frequency.count.other")},{" "}
          <span className={cn(group.clashCount > 0 && "font-semibold text-status-fault")}>
            {group.clashCount}{" "}
            {t(group.clashCount === 1 ? "frequency.clash.one" : "frequency.clash.other")}
          </span>
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-1.5">{t("frequency.col.frequency")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.band")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.channel")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.device")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.type")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.room")}</th>
              <th className="px-4 py-1.5">{t("frequency.col.status")}</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "border-border border-b last:border-b-0",
                  row.clash && "border-l-2 border-l-status-fault bg-status-fault/5",
                )}
              >
                <td className="nums px-4 py-1.5 whitespace-nowrap">{row.frequencyMhz} MHz</td>
                <td className="nums px-4 py-1.5 text-muted-foreground">{row.band ?? <Dash />}</td>
                <td className="nums px-4 py-1.5 text-muted-foreground">
                  {row.channelLabel ?? <Dash />}
                </td>
                <td className="px-4 py-1.5">
                  <span>
                    {row.name ?? (
                      <span className="font-mono text-muted-foreground">#{row.id.slice(-6)}</span>
                    )}
                  </span>
                  {row.clash ? (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded-sm border border-status-fault/30 bg-status-fault/15 px-1.5 py-0.5 text-xs text-foreground align-middle"
                      title={t("frequency.clash.title", { partners: row.clashPartners.join(", ") })}
                    >
                      {t("frequency.clash.badge", { partners: row.clashPartners.join(", ") })}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-1.5 text-muted-foreground">
                  {row.micKind ? micKindLabel(locale, row.micKind) : <Dash />}
                </td>
                <td className="px-4 py-1.5 text-muted-foreground whitespace-nowrap">
                  {row.roomName ?? <Dash />}
                </td>
                <td className="px-4 py-1.5">
                  <StatusBadge kind="equipment" value={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
