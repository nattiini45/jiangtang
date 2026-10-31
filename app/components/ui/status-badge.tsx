import { cn } from "~/lib/utils";
import { statusToken } from "~/lib/status";
import type {
  EquipmentStatus,
  EventStatus,
  ProjectStatus,
  RoomStatus,
  TaskStatus,
  TicketStatus,
} from "~/generated/prisma/client";
import { useLocale } from "~/i18n/use-t";

type Props =
  | { kind: "room"; value: RoomStatus }
  | { kind: "equipment"; value: EquipmentStatus }
  | { kind: "ticket"; value: TicketStatus }
  | { kind: "event"; value: EventStatus }
  | { kind: "project"; value: ProjectStatus }
  | { kind: "task"; value: TaskStatus };

/** A status pill driven by the frozen statusToken map. */
export function StatusBadge(props: Props & { className?: string }) {
  const locale = useLocale();
  // The discriminated union guarantees kind/value line up.
  const token = statusToken(locale, props.kind, props.value as never);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-xs",
        token.className,
        props.className,
      )}
    >
      {token.label}
    </span>
  );
}
