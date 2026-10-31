import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Shared empty state — icon + text + an optional primary action. Used
 * wherever a list can be empty; a bare „Keine Einträge." line is not a state.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  /** Secondary line — what the user can do about the emptiness. */
  hint?: string;
  action?: { to: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border text-muted-foreground flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <Icon className="size-6" aria-hidden />
      <p className="text-foreground text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs">{hint}</p> : null}
      {action ? (
        <Link
          to={action.to}
          className="border-border text-foreground hover:border-foreground/50 mt-2 inline-flex min-h-9 items-center rounded-sm border px-3 text-sm"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
