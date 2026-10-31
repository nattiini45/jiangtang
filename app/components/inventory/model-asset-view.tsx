import { Link } from "react-router";
import { cn } from "~/lib/utils";
import { MonoCell } from "~/components/data-grid";
import { StatusBadge } from "~/components/ui/status-badge";
import { useT } from "~/i18n/use-t";
import type { ModelInstanceRow, ModelStats } from "~/domains/catalog/catalog.queries.server";

/** By-model asset view: failure stats + the instance list ("which model fails most"). */
export function ModelAssetView({
  stats,
  instances,
}: {
  stats: ModelStats;
  instances: ModelInstanceRow[];
}) {
  const t = useT();
  const cards = [
    { label: t("inventory.models.stat.total"), value: stats.total, cls: "" },
    {
      label: t("status.equipment.OPERATIONAL"),
      value: stats.operational,
      cls: "text-status-operational",
    },
    {
      label: t("status.equipment.FAULTY"),
      value: stats.faulty,
      cls: stats.faulty ? "text-status-fault" : "",
    },
    {
      label: t("status.equipment.MAINTENANCE"),
      value: stats.maintenance,
      cls: stats.maintenance ? "text-status-warning" : "",
    },
    { label: t("status.equipment.RETIRED"), value: stats.retired, cls: "text-muted-foreground" },
    {
      label: t("inventory.models.stat.openTickets"),
      value: stats.openTickets,
      cls: stats.openTickets ? "text-status-info" : "",
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="border-border border p-2 text-center">
            <p className={cn("font-mono text-lg", c.cls)}>{c.value}</p>
            <p className="text-muted-foreground text-xs">{c.label}</p>
          </div>
        ))}
      </div>

      {instances.length > 0 ? (
        <ul className="border-border divide-border divide-y border text-sm">
          {instances.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-3 py-1.5">
              <Link to={`/inventory/${e.id}`} className="hover:underline">
                {e.name ?? "—"}
              </Link>
              {e.assetTag ? <MonoCell>{e.assetTag}</MonoCell> : null}
              {e.roomName ? (
                <Link to={`/rooms/${e.roomSlug}`} className="text-muted-foreground hover:underline">
                  {e.roomName}
                </Link>
              ) : (
                <span className="text-muted-foreground text-xs">{t("inventory.col.pool")}</span>
              )}
              <span className="ml-auto">
                <StatusBadge kind="equipment" value={e.status} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("inventory.models.noDevices")}</p>
      )}
    </section>
  );
}
