import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Bordered panel shell for an analytics chart. Keeps the industrial
 * aesthetic: structural border, mono header, restrained neutrals. Chart libraries
 * render inside; this wrapper just frames them consistently.
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
    <section className={cn("border-border bg-card flex flex-col border", className)}>
      <header className="border-border border-b px-3 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle ? <p className="text-muted-foreground text-xs">{subtitle}</p> : null}
      </header>
      <div className="min-h-[220px] flex-1 p-3">{children}</div>
    </section>
  );
}
