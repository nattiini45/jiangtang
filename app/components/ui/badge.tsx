import * as React from "react";
import { cn } from "~/lib/utils";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "border-border bg-secondary text-secondary-foreground inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-xs",
        className,
      )}
      {...props}
    />
  );
}
