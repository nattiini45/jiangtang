import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/button";

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
        "text-muted-foreground flex flex-col items-center gap-1 px-6 py-10 text-center",
        className,
      )}
    >
      <span className="bg-tint mb-2 flex size-10 items-center justify-center rounded-lg">
        <Icon className="size-5" strokeWidth={1.5} aria-hidden />
      </span>
      <p className="text-foreground font-semibold">{title}</p>
      {hint ? <p className="max-w-sm text-xs">{hint}</p> : null}
      {action ? (
        <Link
          to={action.to}
          className={buttonVariants({ variant: "tertiary", size: "compact", className: "mt-3" })}
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
