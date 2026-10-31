import type { ServiceWindowKind } from "~/generated/prisma/client";
import { formatDateWith } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { serviceWindowKindLabel } from "~/components/events/labels";

/**
 * Proportional time-strip for an event: one row per booked room plus a service-
 * window row, bars positioned across a shared axis. Client-safe (Intl + Date
 * math only). The axis spans the union of the event window and all items so
 * setup/teardown windows outside the event window stay visible.
 */

interface Span {
  startsAt: Date | string;
  endsAt: Date | string;
}
interface RoomBar extends Span {
  roomName: string;
}
interface WindowBar extends Span {
  kind: ServiceWindowKind;
  roomName: string | null;
}

const timeOptions: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

const ms = (d: Date | string) => new Date(d).getTime();

const WINDOW_TONE: Record<ServiceWindowKind, string> = {
  SETUP: "bg-status-info/70 border-status-info",
  STANDBY: "bg-status-warning/70 border-status-warning",
  TEARDOWN: "bg-muted-foreground/40 border-muted-foreground",
};

export function EventTimeline({
  start,
  end,
  rooms,
  serviceWindows,
}: {
  start: Date | string;
  end: Date | string;
  rooms: RoomBar[];
  serviceWindows: WindowBar[];
}) {
  const locale = useLocale();
  const t = useT();
  const fmtTime = (d: Date | string | number) => formatDateWith(locale, d, timeOptions);
  const all = [{ startsAt: start, endsAt: end }, ...rooms, ...serviceWindows];
  const axisStart = Math.min(...all.map((s) => ms(s.startsAt)));
  const axisEnd = Math.max(...all.map((s) => ms(s.endsAt)));
  const total = axisEnd - axisStart;
  if (!(total > 0)) return null;

  const pos = (s: Span) => {
    const left = ((ms(s.startsAt) - axisStart) / total) * 100;
    const width = ((ms(s.endsAt) - ms(s.startsAt)) / total) * 100;
    return { left: `${Math.max(0, left)}%`, width: `${Math.max(1, Math.min(100 - left, width))}%` };
  };

  // Group room bars by room name into rows.
  const roomRows = new Map<string, RoomBar[]>();
  for (const r of rooms) {
    const arr = roomRows.get(r.roomName) ?? [];
    arr.push(r);
    roomRows.set(r.roomName, arr);
  }

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center gap-2">
      <div className="text-muted-foreground w-28 shrink-0 truncate text-xs" title={label}>
        {label}
      </div>
      <div className="bg-muted/40 relative h-6 flex-1 rounded-sm">{children}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {[...roomRows.entries()].map(([name, bars]) => (
        <Row key={name} label={name}>
          {bars.map((b, i) => (
            <div
              key={i}
              className="border-primary bg-primary/70 absolute top-0.5 h-5 rounded-sm border"
              style={pos(b)}
              title={`${name}: ${fmtTime(new Date(b.startsAt))} – ${fmtTime(new Date(b.endsAt))}`}
            />
          ))}
        </Row>
      ))}

      {serviceWindows.length > 0 ? (
        <Row label={t("timeline.serviceRow")}>
          {serviceWindows.map((w, i) => (
            <div
              key={i}
              className={`absolute top-0.5 h-5 rounded-sm border ${WINDOW_TONE[w.kind]}`}
              style={pos(w)}
              title={`${serviceWindowKindLabel(locale, w.kind)}${w.roomName ? ` · ${w.roomName}` : ""}: ${fmtTime(new Date(w.startsAt))} – ${fmtTime(new Date(w.endsAt))}`}
            />
          ))}
        </Row>
      ) : null}

      <div className="text-muted-foreground mt-1 flex justify-between pl-30 font-mono text-[10px]">
        <span>{fmtTime(new Date(axisStart))}</span>
        <span>{fmtTime(new Date(axisEnd))}</span>
      </div>
    </div>
  );
}
