import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Panel shell for an analytics chart. The panel is a raised surface; chart
 * libraries render inside it with the theme's color tokens.
 */
export function ChartCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-card shadow-surface-2 flex flex-col rounded-lg", className)}>
      <header className="px-4 pt-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle ? <p className="text-muted-foreground text-xs">{subtitle}</p> : null}
      </header>
      <div className="min-h-[220px] flex-1 p-4">{children}</div>
    </section>
  );
}
