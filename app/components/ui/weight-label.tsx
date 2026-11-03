import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A label that turns semibold without moving its neighbours: an invisible
 * semibold copy in the same grid cell reserves the wider width, and the visible
 * copy changes weight over 80ms. Use it for selected nav rows, tabs and
 * segmented controls.
 */
export function WeightLabel({
  active,
  children,
  className,
}: {
  active: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("grid min-w-0", className)}>
      <span aria-hidden className="invisible col-start-1 row-start-1 truncate font-semibold">
        {children}
      </span>
      <span
        className={cn(
          "col-start-1 row-start-1 truncate transition-[font-weight,font-variation-settings] duration-80",
          active ? "font-semibold" : "font-normal",
        )}
      >
        {children}
      </span>
    </span>
  );
}
