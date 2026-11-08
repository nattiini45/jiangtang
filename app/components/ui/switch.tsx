import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Toggle switch built on a visually-hidden native checkbox (peer), so it submits
 * through <Form> like any checkbox. The checked track is the accent; the thumb
 * stretches into a pill on hover and travels on the moderate tier (0.16s). Under
 * reduced motion it jumps instead of sliding.
 */
export const Switch = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => {
  return (
    <label
      className={cn(
        "group relative inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center",
        className,
      )}
    >
      <input type="checkbox" ref={ref} className="peer sr-only" {...props} />
      <span className="bg-switch-track absolute inset-0 rounded-full transition-colors duration-160 peer-checked:bg-fluid-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--focus-ring) peer-disabled:opacity-50" />
      <span className="bg-switch-thumb absolute left-0.5 h-4 w-4 rounded-full shadow-(--switch-shadow) transition-[translate,width] duration-160 ease-(--ease-press) group-hover:w-[18px] peer-checked:translate-x-[14px] peer-checked:group-hover:translate-x-3 motion-reduce:transition-none" />
    </label>
  );
});
Switch.displayName = "Switch";
