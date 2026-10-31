import * as React from "react";
import { cn } from "~/lib/utils";

/** Native multiline text input, styled to match the Input primitive (sans — holds prose). */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "border-input bg-background flex min-h-20 w-full rounded-sm border px-3 py-2 text-sm shadow-sm transition-colors",
          "placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
