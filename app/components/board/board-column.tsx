import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "~/lib/utils";
import { useT } from "~/i18n/use-t";
import { TaskCard, type BoardCard } from "./task-card";
import { TicketCard, type BoardTicket } from "./ticket-card";

/**
 * One lane on `/board`: a `useDroppable` container (dropping on the empty
 * space/appended card targets the lane itself) wrapping a `SortableContext` of
 * its cards. The column id IS the lane name — that is what lets `onDragEnd`
 * distinguish "dropped on a card" from "dropped on the lane".
 *
 * In work mode a „Tickets" sub-group sits below the tasks. Ticket cards
 * are draggable but not sortable — the sub-group has no `SortableContext`, so
 * tasks never reorder around them and a ticket drop only ever means a lane
 * change.
 */
export function BoardColumn({
  lane,
  title,
  tasks,
  tickets = [],
}: {
  lane: string;
  title: string;
  tasks: BoardCard[];
  tickets?: BoardTicket[];
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: lane });
  const count = tasks.length + tickets.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      className={cn(
        "border-border bg-muted/40 flex min-h-40 w-64 shrink-0 flex-col rounded-sm border",
        isOver && "border-primary",
      )}
    >
      <header className="border-border flex items-center justify-between border-b px-2 py-1.5">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wide">{title}</h2>
        <span
          className="text-muted-foreground font-mono text-xs"
          aria-label={t("board.column.entries", { count })}
        >
          {count}
        </span>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-2 p-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {tickets.length > 0 ? (
            <div className="border-border mt-1 flex flex-col gap-2 border-t pt-2">
              <h3 className="text-muted-foreground font-mono text-[10px] font-semibold uppercase tracking-wide">
                {t("board.column.tickets")}
              </h3>
              {tickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} />
              ))}
            </div>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}
