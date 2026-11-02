import * as React from "react";
import { cn } from "~/lib/utils";
import { fieldClassName } from "~/components/ui/input";

/** Native multiline text input, styled to match the Input primitive. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(fieldClassName, "px-control py-row flex min-h-20", className)}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
