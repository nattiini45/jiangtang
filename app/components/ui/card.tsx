import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A panel on the page: one surface step up, separated by its shadow rather
 * than a drawn border. Rows inside separate with hairline dividers.
 */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("bg-card text-card-foreground shadow-surface-2 rounded-lg", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn("flex min-h-12 items-center justify-between gap-2 px-4 py-3", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("flex items-center gap-2 text-base font-semibold [&_svg]:size-4", className)}
      {...props}
    />
  );
}
