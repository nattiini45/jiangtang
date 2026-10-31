import { Link } from "react-router";
import { formatDateWith } from "~/i18n/format";
import type { Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";
import type {
  AllocationWindow,
  UnitAvailabilityRow,
} from "~/domains/inventory/inventory.availability.server";

/**
 * Pooled-equipment availability timeline. A Gantt-style strip per
 * pooled unit showing booked blocks across the visible window; gaps are free.
 * Renders on the equipment detail (one unit) and the by-model asset view (all
 * units of a model). Pure/client-safe.
 */

function statusColor(status: string): string {
  // Cancelled events shouldn't appear (filtered out), but keep a defensive fall-through.
  if (status === "CANCELLED") return "bg-muted";
  return "bg-status-info/70";
}

export function AvailabilityTimeline({
  units,
  from,
  to,
}: {
  units: UnitAvailabilityRow[];
  from: Date;
  to: Date;
}) {
  const locale = useLocale();
  const t = useT();
  const span = to.getTime() - from.getTime();
  if (units.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("inventory.availability.none")}</p>;
  }

  return (
    <div className="border-border flex flex-col border">
      <div className="border-border border-b px-3 py-2">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {t("inventory.availability.heading")} · {fmtRange(locale, from, to)}
        </p>
      </div>
      <div className="divide-border divide-y">
        {units.map((unit) => (
          <UnitRow key={unit.equipmentId} unit={unit} from={from} span={span} />
        ))}
      </div>
      <Legend />
    </div>
  );
}

function UnitRow({ unit, from, span }: { unit: UnitAvailabilityRow; from: Date; span: number }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="w-40 shrink-0 truncate text-sm">
        <Link to={`/inventory/${unit.equipmentId}`} className="hover:underline">
          {unit.equipmentLabel}
        </Link>
      </div>
      <div className="border-border relative h-5 flex-1 border bg-muted/20">
        {unit.windows.map((w) => (
          <Block key={w.allocationId} w={w} from={from} span={span} />
        ))}
      </div>
    </div>
  );
}

function Block({ w, from, span }: { w: AllocationWindow; from: Date; span: number }) {
  const locale = useLocale();
  const left = ((w.startsAt.getTime() - from.getTime()) / span) * 100;
  const width = ((w.endsAt.getTime() - w.startsAt.getTime()) / span) * 100;
  return (
    <Link
      to={`/events/${w.eventId}`}
      title={`${w.eventTitle} · ${fmt(locale, w.startsAt)}–${fmt(locale, w.endsAt)}`}
      className={["absolute top-0 h-full min-w-[2px] rounded-sm", statusColor(w.eventStatus)].join(
        " ",
      )}
      style={{
        left: `${Math.max(0, left)}%`,
        width: `${Math.min(100 - left, width)}%`,
      }}
    />
  );
}

function Legend() {
  const t = useT();
  return (
    <div className="text-muted-foreground border-border flex items-center gap-3 border-t px-3 py-1.5 text-xs">
      <span className="flex items-center gap-1">
        <span className="bg-status-info/70 inline-block h-2.5 w-4 rounded-sm" />{" "}
        {t("inventory.availability.booked")}
      </span>
      <span className="flex items-center gap-1">
        <span className="bg-muted border-border inline-block h-2.5 w-4 rounded-sm border" />{" "}
        {t("inventory.availability.free")}
      </span>
    </div>
  );
}

function fmt(locale: Locale, d: Date): string {
  return formatDateWith(locale, d, { dateStyle: "short", timeStyle: "short" });
}

function fmtRange(locale: Locale, a: Date, b: Date): string {
  return `${fmt(locale, a)} – ${fmt(locale, b)}`;
}
