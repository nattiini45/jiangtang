import { Link } from "react-router";
import { LOCATION_KINDS, kindLabel } from "./labels";
import { cn } from "~/lib/utils";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The `kind` filter, as links — and **the whole of the filter's state is the
 * URL**.
 *
 * Each entry is a plain `<Link to="/locations?kind=…">`, so a copied address bar
 * reproduces the filtered view with no component state, no query client and no
 * effect to keep in sync. That is the property the filter exists to guarantee, and
 * it is why this is not a `<Form method="get">` around a `<Select>`: a select
 * needs a submit, so the filter would only exist after a round trip through the
 * address bar, and "share this filtered view" would share the unfiltered one.
 *
 * The **active** kind comes from the loader as a prop, read out of the same
 * `?kind=` the query used — the component never decides which kind is active, it
 * only renders what it was told. A value the loader rejected is therefore simply
 * never highlighted, rather than being highlighted by a client-side guess.
 */
export function LocationKindFilter({ active }: { active: string }) {
  const locale = useLocale();
  const t = useT();
  const items: Array<{ kind: string; label: string; to: string }> = [
    { kind: "", label: t("common.all"), to: "/locations" },
    ...LOCATION_KINDS.map((k) => ({
      kind: k,
      label: kindLabel(locale, k),
      to: `/locations?kind=${k}`,
    })),
  ];

  return (
    <nav aria-label={t("locations.filter.label")} className="flex flex-wrap items-center gap-1">
      {items.map((item) => {
        const isActive = item.kind === active;
        return (
          <Link
            key={item.kind || "all"}
            to={item.to}
            preventScrollReset
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "border-border rounded-sm border px-2 py-1 font-mono text-xs",
              isActive
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent text-muted-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
