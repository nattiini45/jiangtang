import * as React from "react";
import { cn } from "~/lib/utils";

export const Label = React.forwardRef<HTMLLabelElement, React.ComponentProps<"label">>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("text-foreground text-xs font-semibold peer-disabled:opacity-50", className)}
      {...props}
    />
  ),
);
Label.displayName = "Label";
