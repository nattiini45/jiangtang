import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "~/lib/utils";
import { fieldClassName } from "~/components/ui/input";

/**
 * Native <select> styled to match the Input primitive. Consumers pass <option>
 * children; the native element submits its value through react-router <Form>
 * with no hidden-input plumbing. `className` styles the wrapper (width/layout) so
 * the chevron stays pinned to the control's right edge; the inner select is
 * always full-width.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className={cn("relative w-full", className)}>
        <select
          ref={ref}
          className={cn(fieldClassName, "h-control pl-control cursor-pointer appearance-none pr-8")}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          strokeWidth={1.5}
          className="text-muted-foreground size-icon pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
        />
      </div>
    );
  },
);
Select.displayName = "Select";
