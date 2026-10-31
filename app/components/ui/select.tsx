import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Native <select> styled to match the Input primitive. Consumers pass <option>
 * children; the native element submits its value through react-router <Form>
 * with no hidden-input plumbing. `className` styles the wrapper (width/layout) so
 * the chevron stays pinned to the control's right edge; the inner select is
 * always full-width. Sans text — selects choose among prose labels.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className={cn("relative w-full", className)}>
        <select
          ref={ref}
          className={cn(
            "border-input bg-background h-9 w-full appearance-none rounded-sm border pl-3 pr-8 text-sm shadow-sm transition-colors",
            "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2" />
      </div>
    );
  },
);
Select.displayName = "Select";
