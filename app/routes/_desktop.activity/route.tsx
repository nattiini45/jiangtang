import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import {
  Activity,
  Boxes,
  Building2,
  CalendarDays,
  FolderKanban,
  ListTodo,
  MapPin,
  NotebookPen,
  Package,
  Paperclip,
  School,
  Ticket,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { requireUser } from "~/lib/auth.server";
import { EmptyState } from "~/components/states/empty-state";
import { ENTITY_TYPES, type EntityType } from "~/lib/realtime/events";
import { listActivity } from "~/domains/activity/activity.queries.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { actionLabel, entityTypeLabel } from "~/components/history/labels";
import { groupActivity } from "~/components/history/group-activity";
import { DateCell } from "~/components/data-grid";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/activity` — the global feed: every ActivityLog row, newest first,
 * cursor-paginated, filtered by actor and entity type. Autosave runs collapse
 * via `groupActivity`. Read-only — nothing here mutates, so nothing emits.
 */

const TYPE_ICON: Partial<Record<EntityType, LucideIcon>> = {
  task: ListTodo,
  ticket: Ticket,
  project: FolderKanban,
  note: NotebookPen,
  location: MapPin,
  "inventory-item": Warehouse,
  equipment: Boxes,
  equipmentModel: Package,
  event: CalendarDays,
  room: Building2,
  campus: School,
  user: Users,
  attachment: Paperclip,
};

const isEntityType = (v: string): v is EntityType =>
  (ENTITY_TYPES as readonly string[]).includes(v);

function actorInitials(snapshot: unknown, actorId: string | null): string {
  if (snapshot && typeof snapshot === "object") {
    const s = snapshot as { initials?: unknown; name?: unknown; email?: unknown };
    if (typeof s.initials === "string" && s.initials) return s.initials;
    if (typeof s.name === "string" && s.name) return s.name;
    if (typeof s.email === "string" && s.email) return s.email;
  }
  return actorId ? `#${actorId.slice(-4)}` : "—";
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "activity.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const actorParam = url.searchParams.get("actor")?.trim() || undefined;
  // Garbage params degrade to unfiltered — the list-filter contract.
  const entityTypes = url.searchParams
    .getAll("type")
    .map((type) => type.trim())
    .filter(isEntityType);
  const users = await listUsers();
  const actorId = actorParam && users.some((u) => u.id === actorParam) ? actorParam : undefined;

  const { items, nextCursor } = await listActivity({
    actorId,
    entityTypes: entityTypes.length ? entityTypes : undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  return {
    entries: groupActivity(items),
    nextCursor,
    users: users.filter((u) => u.isActive),
    filters: { actor: actorParam ?? "", types: entityTypes },
  };
}

export default function ActivityPage({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { entries, nextCursor, users, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    e.currentTarget.form?.requestSubmit();
  const olderHref = () => {
    const q = new URLSearchParams();
    if (filters.actor) q.set("actor", filters.actor);
    for (const type of filters.types) q.append("type", type);
    if (nextCursor) q.set("cursor", nextCursor);
    return `/activity?${q}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-xl">{t("nav.activity")}</h1>
        <p className="text-muted-foreground text-sm">{t("activity.subtitle")}</p>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="actor"
          defaultValue={filters.actor}
          className="max-w-[14rem]"
          onChange={autoSubmit}
          aria-label={t("activity.filterByPerson")}
        >
          <option value="">{t("activity.allPeople")}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        {ENTITY_TYPES.map((type) => (
          <label
            key={type}
            className={cn(
              "border-border text-muted-foreground inline-flex cursor-pointer items-center rounded-sm border px-2 py-1 font-mono text-xs",
              "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-foreground",
            )}
          >
            <input
              type="checkbox"
              name="type"
              value={type}
              defaultChecked={filters.types.includes(type)}
              onChange={autoSubmit}
              className="sr-only"
            />
            {entityTypeLabel(locale, type)}
          </label>
        ))}
        <noscript>
          <Button type="submit" variant="outline" size="sm">
            {t("activity.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      {entries.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t("activity.empty.title")}
          hint={t("activity.empty.hint")}
        />
      ) : (
        <ul className="divide-border divide-y">
          {entries.map((e) => {
            const Icon = TYPE_ICON[e.entityType as EntityType] ?? Activity;
            return (
              <li key={e.id} className="flex items-center gap-2 px-1 py-2 text-sm">
                <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <span className="text-muted-foreground font-mono text-xs">
                  {entityTypeLabel(locale, e.entityType as EntityType) ?? e.entityType}
                </span>
                <span>{actionLabel(locale, e.action)}</span>
                {e.href ? (
                  <Link to={e.href} className="truncate hover:underline">
                    {e.title}
                  </Link>
                ) : (
                  <span className="text-muted-foreground truncate">{e.title}</span>
                )}
                {e.count > 1 ? (
                  <span
                    className="text-muted-foreground font-mono text-xs"
                    aria-label={t("activity.grouped", { count: e.count })}
                  >
                    ×{e.count}
                  </span>
                ) : null}
                <span className="border-border bg-secondary text-secondary-foreground ml-auto inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-xs">
                  {actorInitials(e.actorSnapshot, e.actorId)}
                </span>
                <span className="text-muted-foreground shrink-0">
                  <DateCell value={e.occurredAt} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor ? (
        <div>
          <Button variant="outline" size="sm" asChild>
            <Link to={olderHref()}>{t("activity.loadOlder")}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
