import { Link } from "react-router";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Ticket as TicketIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { MessageKey } from "~/i18n";
import { useT } from "~/i18n/use-t";
import type { TicketStatus, TicketType } from "~/generated/prisma/client";

/**
 * A ticket card in `/board`'s work mode. Tickets sort **below** the tasks
 * of a lane, in a fixed view order — they are `useDraggable`, NOT sortable:
 * dropping one only ever changes its lane (there is no ticket position column),
 * and a same-lane drop is ignored by the board before any POST.
 *
 * The draggable id is namespaced (`ticket:<cuid>`) so it can never collide with
 * a task id in the DndContext registry and the board can tell the two families
 * apart by the id alone.
 */
export interface BoardTicket {
  id: string;
  shortId: string;
  title: string;
  type: TicketType;
  status: TicketStatus;
  priority: number | null;
  room: { slug: string; name: string; roomNumber: string | null } | null;
  assignees: Array<{ id: string; name: string; initials: string | null }>;
}

export const ticketDragId = (id: string) => `ticket:${id}`;
export const parseTicketDragId = (id: string): string | null =>
  id.startsWith("ticket:") ? id.slice("ticket:".length) : null;

/** Ticket priority (1–3) → catalog key; an unknown number falls back to the raw value. */
const TICKET_PRIORITY_KEYS: Partial<Record<number, MessageKey>> = {
  1: "board.ticket.priority.1",
  2: "board.ticket.priority.2",
  3: "board.ticket.priority.3",
};

export function TicketCard({ ticket }: { ticket: BoardTicket }) {
  const t = useT();
  const priorityKey = ticket.priority != null ? TICKET_PRIORITY_KEYS[ticket.priority] : undefined;
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: ticketDragId(ticket.id),
  });
  // The card is also a droppable so keyboard dragging works: the board's
  // sortableKeyboardCoordinates needs the active item in the droppable
  // registry, and without it arrow keys move nothing. `onDragEnd` resolves a
  // ticket target to its lane through the same id.
  const { setNodeRef: setDroppableNodeRef } = useDroppable({ id: ticketDragId(ticket.id) });
  const setNodeRef = (node: HTMLElement | null) => {
    setDraggableNodeRef(node);
    setDroppableNodeRef(node);
  };
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "bg-card shadow-surface-2 flex flex-col gap-1.5 rounded-md p-2 text-sm",
        isDragging && "shadow-surface-3 z-10 opacity-80",
      )}
      {...listeners}
    >
      <div className="flex items-start gap-1.5">
        {/* Same split as TaskCard: role/tabIndex/aria on the grip handle so
            the card does not become an interactive parent of the links. */}
        <button
          type="button"
          {...attributes}
          aria-label={t("board.ticket.gripAria", { title: ticket.title })}
          className="text-muted-foreground hover:bg-hover mt-0.5 inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <TicketIcon
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
          aria-label={t("board.ticket.iconAria")}
          role="img"
        />
        <Link
          to={`/tickets/${ticket.id}`}
          className="min-w-0 break-words hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ticket.title}
        </Link>
        {ticket.priority != null ? (
          <span className="text-muted-foreground nums ml-auto shrink-0 text-xs">
            {priorityKey ? t(priorityKey) : ticket.priority}
          </span>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-mono">{ticket.shortId}</span>
        <span className="bg-tint text-foreground type-micro rounded-xs px-1 py-px font-semibold">
          {t(`search.ticketType.${ticket.type}`)}
        </span>
        {ticket.room ? (
          <Link to={`/rooms/${ticket.room.slug}`} className="font-mono hover:underline">
            {ticket.room.roomNumber ?? ticket.room.name}
          </Link>
        ) : null}
        <span className="ml-auto flex gap-0.5">
          {ticket.assignees.map((a) => (
            <span
              key={a.id}
              title={a.name}
              className="bg-tint text-foreground type-micro inline-flex items-center rounded-xs px-1 py-0.5 font-semibold"
            >
              {a.initials ?? a.name}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
