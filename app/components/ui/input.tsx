import * as React from "react";
import { cn } from "~/lib/utils";

/*
 * Fields sit on the control height with an inset 1px ring instead of a border,
 * so hover and focus change contrast without the stroke appearing to thicken or
 * the box changing size. Shared by Input, Textarea and Select. The weight is set
 * explicitly: a field nested in a semibold <Label> would otherwise inherit it.
 */
export const fieldClassName = cn(
  "bg-card text-foreground w-full rounded-md text-sm font-normal shadow-[inset_0_0_0_1px_var(--input)] transition-[box-shadow,background-color] duration-80",
  "placeholder:text-muted-foreground hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--input),var(--foreground)_18%)]",
  "focus-visible:outline-offset-0 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          fieldClassName,
          "h-control px-control file:text-foreground flex file:mr-2 file:border-0 file:bg-transparent file:text-sm file:font-semibold",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
