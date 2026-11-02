import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

/*
 * The fill is a layer 1px inside the button, grown back to full size by a 1px
 * spread of the same color. Pressing collapses the spread, so the surface shrinks
 * exactly 1px per side at any width (a scale would warp a wide button). The press
 * lands in 80ms and releases over 180ms. Icons thicken on hover instead of the
 * label changing weight.
 */
const buttonVariants = cva(
  [
    "relative isolate inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-semibold whitespace-nowrap select-none",
    "before:absolute before:inset-px before:-z-10 before:rounded-[calc(var(--radius-md)-1px)] before:bg-(--btn-bg) before:shadow-[0_0_0_1px_var(--btn-bg)]",
    "before:transition-[box-shadow,background-color] before:duration-[180ms,80ms] before:ease-(--ease-press)",
    "hover:before:bg-(--btn-bg-hover) hover:before:shadow-[0_0_0_1px_var(--btn-bg-hover)]",
    "active:before:shadow-[0_0_0_0_var(--btn-bg-hover)] active:before:duration-80",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:size-icon [&_svg]:shrink-0 [&_svg]:[stroke-width:1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 hover:[&_svg]:[stroke-width:2]",
  ],
  {
    variants: {
      variant: {
        primary:
          "text-primary-foreground [--btn-bg-hover:color-mix(in_oklab,var(--primary)_86%,var(--background))] [--btn-bg:var(--primary)]",
        secondary: "text-foreground [--btn-bg-hover:var(--tint-hover)] [--btn-bg:var(--tint)]",
        // The border is an outer 1px ring at rest that moves inside when pressed,
        // following the shrinking surface.
        tertiary:
          "text-foreground shadow-[0_0_0_1px_var(--input)] transition-shadow duration-80 [--btn-bg-hover:var(--hover)] [--btn-bg:transparent] active:shadow-[inset_0_0_0_1px_var(--input)]",
        ghost: "text-foreground [--btn-bg-hover:var(--hover)] [--btn-bg:transparent]",
        destructive:
          "text-destructive-foreground [--btn-bg-hover:color-mix(in_oklab,var(--destructive)_88%,black)] [--btn-bg:var(--destructive)]",
        link: "text-foreground font-normal underline decoration-(--input) underline-offset-4 transition-colors duration-80 before:hidden hover:decoration-current",
      },
      size: {
        default:
          "h-control px-button text-sm has-[>svg:first-child]:pl-[calc(var(--button-px)-4px)] has-[>svg:last-child]:pr-[calc(var(--button-px)-4px)]",
        compact:
          "h-7 px-3 text-xs [--icon:14px] has-[>svg:first-child]:pl-2 has-[>svg:last-child]:pr-2",
        icon: "size-control",
        "icon-compact": "size-7 [--icon:14px]",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

// Earlier names, kept so call sites read the same as the stock shadcn API.
const VARIANT_ALIAS = { default: "primary", outline: "tertiary" } as const;
const SIZE_ALIAS = { sm: "compact", lg: "default" } as const;

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type Size = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant | keyof typeof VARIANT_ALIAS | null;
  size?: Size | keyof typeof SIZE_ALIAS | null;
  asChild?: boolean;
}

function resolveVariant(variant: ButtonProps["variant"]): Variant | undefined {
  if (!variant) return undefined;
  return variant in VARIANT_ALIAS
    ? VARIANT_ALIAS[variant as keyof typeof VARIANT_ALIAS]
    : (variant as Variant);
}

function resolveSize(size: ButtonProps["size"]): Size | undefined {
  if (!size) return undefined;
  return size in SIZE_ALIAS ? SIZE_ALIAS[size as keyof typeof SIZE_ALIAS] : (size as Size);
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(
          buttonVariants({
            variant: resolveVariant(variant),
            size: resolveSize(size),
            className,
          }),
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

function buttonClassName(
  options: {
    variant?: ButtonProps["variant"];
    size?: ButtonProps["size"];
    className?: string;
  } = {},
): string {
  return buttonVariants({
    variant: resolveVariant(options.variant),
    size: resolveSize(options.size),
    className: options.className,
  });
}

export { buttonClassName as buttonVariants };
