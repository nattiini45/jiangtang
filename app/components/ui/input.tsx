import * as React from "react";
import { cn } from "~/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          "border-input bg-background flex h-9 w-full rounded-sm border px-3 py-1 font-mono text-sm shadow-sm transition-colors",
          "placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
