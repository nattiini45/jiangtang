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
import { badgeClassName } from "~/components/ui/badge";

type Props =
  | { kind: "room"; value: RoomStatus }
  | { kind: "equipment"; value: EquipmentStatus }
  | { kind: "ticket"; value: TicketStatus }
  | { kind: "event"; value: EventStatus }
  | { kind: "project"; value: ProjectStatus }
  | { kind: "task"; value: TaskStatus };

/** A status pill driven by the frozen statusToken map: tinted fill, colored dot. */
export function StatusBadge(props: Props & { className?: string }) {
  const locale = useLocale();
  // The discriminated union guarantees kind/value line up.
  const token = statusToken(locale, props.kind, props.value as never);
  return (
    <span className={cn(badgeClassName, "border", token.className, props.className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", token.dotClassName)} />
      {token.label}
    </span>
  );
}
