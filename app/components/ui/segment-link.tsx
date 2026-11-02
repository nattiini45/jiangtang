import { Link } from "react-router";
import { cn } from "~/lib/utils";

/**
 * One option of a segmented filter whose options are URLs. Place the options in
 * a `bg-tint flex rounded-full p-0.5` track; the selected one is a raised card.
 * Labels may wrap to two lines on a narrow phone, so the leading stays tight.
 */
export function SegmentLink({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-h-11 flex-1 items-center justify-center rounded-full px-2 text-center text-sm leading-tight transition-colors duration-80",
        active ? "bg-card shadow-surface-1 font-semibold" : "text-muted-foreground",
      )}
    >
      {label}
    </Link>
  );
}
