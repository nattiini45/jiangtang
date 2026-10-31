import * as React from "react";
import { StatusBadge } from "~/components/ui/status-badge";
import { formatDate, formatDateTime } from "~/i18n/format";
import { useLocale } from "~/i18n/use-t";

/**
 * Cell renderers for the DataGrid. Client-safe (no server-only imports): dates
 * are formatted in the active locale on the Europe/Berlin wall clock.
 */

/** Monospace value (IDs, IPs, MACs, room numbers, frequencies). */
export function MonoCell({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

export function DateCell({
  value,
  withTime = true,
}: {
  value: Date | string | null | undefined;
  withTime?: boolean;
}) {
  const locale = useLocale();
  if (!value) return <span className="text-muted-foreground">—</span>;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs">{(withTime ? formatDateTime : formatDate)(locale, d)}</span>
  );
}

export { StatusBadge as StatusCell };
