import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Native checkbox themed via accent-color. Submits "on" through <Form> when
 * checked (our zod schemas preprocess "on"/"true" → boolean). Near-square to
 * match the industrial design language.
 */
export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => {
  return (
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        "border-input accent-primary size-4 shrink-0 rounded-sm border shadow-sm",
        "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Checkbox.displayName = "Checkbox";
