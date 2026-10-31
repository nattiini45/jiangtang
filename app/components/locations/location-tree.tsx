import { Link } from "react-router";
import type { LocationTreeNode } from "~/domains/locations/locations.tree.server";
import { Badge } from "~/components/ui/badge";
import { kindLabel, LOCATION_KIND_BADGE_CLASS } from "./labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The location tree as a dense, indented, divided list.
 *
 * Depth comes from the query (`locations.tree.server.ts` returns the real depth
 * of a node in the hierarchy, **not** its depth inside a `kind`-filtered
 * result), so the indentation is honest even when a filter is active — a `ROOM`
 * under a `BUILDING` is drawn at depth 2 with its building's row simply absent.
 * The alternative, re-deriving depth from the visible rows, would silently
 * collapse the tree to a flat list the moment a filter was on.
 *
 * A tree node is a *read* of `locations.tree.server.ts`; it carries no write
 * path, so this component has no action of its own.
 */

export function LocationTree({
  nodes,
  emptyMessage,
}: {
  nodes: LocationTreeNode[];
  /** Defaults to the generic "no locations" text. */
  emptyMessage?: string;
}) {
  const locale = useLocale();
  const t = useT();
  if (nodes.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        {emptyMessage ?? t("locations.tree.empty")}
      </p>
    );
  }

  return (
    <ul className="border-border divide-border divide-y border">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link
            to={`/locations/${node.id}`}
            className="hover:bg-accent flex items-center gap-3 px-3 py-2"
            // The depth in the hierarchy, not in the rendered list.
            style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
            {node.code ? (
              <span className="text-muted-foreground font-mono text-xs">{node.code}</span>
            ) : null}
            <Badge className={LOCATION_KIND_BADGE_CLASS[node.kind]}>
              {kindLabel(locale, node.kind)}
            </Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
