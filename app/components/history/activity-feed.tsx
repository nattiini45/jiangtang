import { DateCell } from "~/components/data-grid";
import { Badge } from "~/components/ui/badge";
import type { ActivityEntry } from "~/domains/tickets/tickets.history.server";
import { actionLabel } from "~/components/history/labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Per-entity history feed. Renders append-only ActivityLog rows with
 * a verb in the active language, the actor's initials (from the immutable snapshot — survives
 * rename/erasure), and the logical time. Pure/client-safe.
 */

function actorInitials(snapshot: unknown): string {
  if (snapshot && typeof snapshot === "object") {
    const s = snapshot as { initials?: unknown; name?: unknown; email?: unknown };
    if (typeof s.initials === "string" && s.initials) return s.initials;
    if (typeof s.name === "string" && s.name) return s.name;
    if (typeof s.email === "string" && s.email) return s.email;
  }
  return "—";
}

export function ActivityFeed({
  entries,
  emptyMessage,
}: {
  entries: ActivityEntry[];
  emptyMessage?: string;
}) {
  const t = useT();
  const locale = useLocale();
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-sm">{emptyMessage ?? t("history.empty")}</p>
    );
  }
  return (
    <ul className="divide-border divide-y">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center gap-2 px-3 py-2 text-sm">
          <Badge className="type-micro h-5 rounded-full px-1.5 font-semibold">
            {actorInitials(e.actorSnapshot)}
          </Badge>
          <span>{actionLabel(locale, e.action)}</span>
          <span className="text-muted-foreground ml-auto">
            <DateCell value={e.occurredAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}
