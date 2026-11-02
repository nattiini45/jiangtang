import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Native checkbox, so it submits "on" through <Form> when checked (our zod
 * schemas preprocess "on"/"true" → boolean). Drawn as a 16px outline with 5px
 * corners; when checked the outline steps aside and the tick alone marks the
 * state, never a filled box.
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
        "size-4 shrink-0 cursor-pointer appearance-none rounded-[5px] bg-center bg-no-repeat",
        "shadow-[inset_0_0_0_1.5px_var(--checkbox-ring)] transition-shadow duration-80",
        "hover:shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]",
        "checked:[background-image:var(--checkmark)] checked:shadow-none checked:hover:shadow-[inset_0_0_0_1.5px_var(--input)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Checkbox.displayName = "Checkbox";
