import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Toggle switch built on a visually-hidden native checkbox (peer), so it submits
 * through <Form> like any checkbox. Pill track + thumb; use Checkbox for dense
 * feature-flag grids and Switch for prominent single toggles.
 */
export const Switch = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => {
  return (
    <label
      className={cn("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center", className)}
    >
      <input type="checkbox" ref={ref} className="peer sr-only" {...props} />
      <span className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring absolute inset-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-disabled:opacity-50" />
      <span className="bg-background absolute left-0.5 size-4 rounded-full shadow transition-transform peer-checked:translate-x-4" />
    </label>
  );
});
Switch.displayName = "Switch";
