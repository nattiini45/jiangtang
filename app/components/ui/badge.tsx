import * as React from "react";
import { cn } from "~/lib/utils";

/* Fixed height on the ladder: 24px, 20px in compact regions. */
export const badgeClassName =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs whitespace-nowrap in-data-[density=compact]:h-5 in-data-[density=compact]:gap-1";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn(badgeClassName, "bg-tint text-foreground", className)} {...props} />;
}

/** A keyboard key cap. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "bg-tint text-muted-foreground type-micro inline-flex h-5 min-w-5 items-center justify-center rounded-xs px-1 font-sans",
        className,
      )}
      {...props}
    />
  );
}
