import { Link } from "react-router";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, OctagonAlert } from "lucide-react";
import { cn } from "~/lib/utils";
import { DateCell } from "~/components/data-grid";
import { taskPriorityLabel } from "~/components/tasks/labels";
import { isTaskOverdue } from "~/domains/tasks/tasks.dates";
import type { TaskPriority, TaskStatus } from "~/generated/prisma/client";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * One card on `/board` — a `useSortable` item: PointerSensor with an
 * activation distance keeps plain clicks free for the title link; the
 * KeyboardSensor picks the card up with space/enter and moves it with arrows
 * (the `sortableKeyboardCoordinates` the board wires in).
 *
 * The row type is hand-written and serialization-safe — `loaderData` has no
 * Decimal left by the time it reaches the client (`task-columns` sets the
 * precedent).
 */
export interface BoardCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueAt: Date | null;
  labels: string[];
  isBlocked: boolean;
  project: { id: string; name: string; slug: string; color: string | null } | null;
  assignees: Array<{ userId: string; user: { id: string; name: string; initials: string | null } }>;
}

export function TaskCard({ task }: { task: BoardCard }) {
  const locale = useLocale();
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const overdue = isTaskOverdue(task.dueAt, task.status);
  return (
    <div
      ref={setNodeRef}
      data-task-card
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card shadow-surface-2 flex flex-col gap-1.5 rounded-md p-2 text-sm",
        isDragging && "shadow-surface-3 z-10 opacity-80",
      )}
      {...listeners}
    >
      <div className="flex items-start gap-1.5">
        {/* Keyboard sortable: role/tabIndex/aria live on this handle, not the
            card — role="button" on the card would nest the title link inside
            an interactive element. Its keydown bubbles to the card listener. */}
        <button
          type="button"
          {...attributes}
          aria-label={t("board.card.gripAria", { title: task.title })}
          className="text-muted-foreground hover:bg-hover mt-0.5 inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        {task.isBlocked ? (
          <OctagonAlert
            className="text-status-fault mt-0.5 size-3.5 shrink-0"
            aria-label={t("tasks.col.blocked")}
            role="img"
          />
        ) : null}
        <Link
          to={`/tasks/${task.id}`}
          className="min-w-0 break-words hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {task.title}
        </Link>
        {task.priority ? (
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">
            {taskPriorityLabel(locale, task.priority)}
          </span>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {task.project ? (
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{
                backgroundColor: task.project.color ?? "transparent",
                border: "1px solid var(--border)",
              }}
            />
            {task.project.name}
          </span>
        ) : null}
        {task.dueAt ? (
          <span className={cn("nums", overdue && "text-status-fault")}>
            <DateCell value={task.dueAt} withTime={false} />
            {overdue ? " !" : ""}
          </span>
        ) : null}
        {task.labels.slice(0, 2).map((l) => (
          <span key={l}>{l}</span>
        ))}
        <span className="ml-auto flex gap-0.5">
          {task.assignees.map((a) => (
            <span
              key={a.userId}
              title={a.user.name}
              className="bg-tint text-foreground type-micro inline-flex items-center rounded-xs px-1 py-0.5 font-semibold"
            >
              {a.user.initials ?? a.user.name}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
