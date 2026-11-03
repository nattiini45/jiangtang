import { Link, useFetcher } from "react-router";
import {
  AlertTriangle,
  Ban,
  Building2,
  CalendarDays,
  Clock,
  FolderKanban,
  History,
  ListTodo,
  NotebookPen,
  Sparkles,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "./+types/route";
import { requireRole, requireUser } from "~/lib/auth.server";
import { getDueSummary, getMyWork, listBlockedTasks } from "~/domains/tasks/tasks.queries.server";
import { listMyTickets } from "~/domains/tickets/tickets.queries.server";
import { listActivity } from "~/domains/activity/activity.queries.server";
import { getStorageStats } from "~/domains/attachments/attachments.queries.server";
import { workspaceIsEmpty } from "~/domains/dashboard/dashboard.queries.server";
import { getSearchHealth } from "~/lib/search/health.server";
import { loadDemoWorkspace } from "~/lib/demo-seed.server";
import { totalCreated, totalSkipped } from "../../../scripts/seed/workspace-seed";
import { groupActivity, type GroupedActivity } from "~/components/history/group-activity";
import { actionLabel } from "~/components/history/labels";
import { ticketStatusLabel, ticketTypeLabel } from "~/components/tickets/labels";
import { DateCell } from "~/components/data-grid";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { StatusBadge } from "~/components/ui/status-badge";
import { t, type MessageKey, type Translate } from "~/i18n";
import { formatNumber } from "~/i18n/format";
import { resolveLocale } from "~/i18n/locale.server";
import type { Locale } from "~/i18n/locales";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/` — the workspace dashboard. Every card reads a real domain query;
 * the empty-workspace panel offers the admin-only „Demo-Workspace laden"
 * action that runs the same `seedWorkspace` `prisma/seed.ts` runs.
 */

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "dashboard.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const userId = actor.id ?? "";
  const [due, blocked, myWork, myTickets, recent, storage, empty, searchHealth] = await Promise.all(
    [
      getDueSummary(),
      listBlockedTasks(5),
      getMyWork(userId),
      listMyTickets(userId),
      listActivity({ limit: 10 }),
      getStorageStats(),
      workspaceIsEmpty(),
      getSearchHealth(),
    ],
  );
  return {
    isAdmin: actor.role === "ADMIN",
    due,
    blocked,
    myWork,
    myTickets,
    recent: groupActivity(recent.items),
    storage,
    searchHealth,
    empty,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  if (form.get("intent") !== "load-demo") {
    return { error: t(locale, "err.unknownAction") };
  }
  const admin = await requireRole(request, "ADMIN");
  const summary = await loadDemoWorkspace(admin);
  return { loaded: true, created: totalCreated(summary), skipped: totalSkipped(summary) };
}

const QUICK_LINKS: { to: string; labelKey: MessageKey; icon: LucideIcon }[] = [
  { to: "/rooms", labelKey: "nav.rooms", icon: Building2 },
  { to: "/quick-entry", labelKey: "dashboard.quick.entry", icon: Ticket },
  { to: "/events", labelKey: "nav.events", icon: CalendarDays },
];

const ROW_LINK = "truncate decoration-(--input) underline-offset-4 hover:underline";

function formatMinutes(locale: Locale, t: Translate, minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} ${t("common.unit.minutesShort")}`;
  const hours = formatNumber(locale, minutes / 60, { maximumFractionDigits: 1 });
  return `${hours} ${t("common.unit.hoursShort")}`;
}

function formatBytes(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${formatNumber(locale, bytes / 1024, { maximumFractionDigits: 0 })} KB`;
  return `${formatNumber(locale, bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

function actorInitials(snapshot: unknown, actorId: string | null): string {
  if (snapshot && typeof snapshot === "object") {
    const s = snapshot as { initials?: unknown; name?: unknown; email?: unknown };
    if (typeof s.initials === "string" && s.initials) return s.initials;
    if (typeof s.name === "string" && s.name) return s.name;
    if (typeof s.email === "string" && s.email) return s.email;
  }
  return actorId ? `#${actorId.slice(-4)}` : "—";
}

function Card({
  title,
  icon: Icon,
  children,
  footer,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="bg-card shadow-surface-2 flex flex-col rounded-lg">
      <header className="flex h-12 items-center gap-2 px-4">
        <Icon className="text-muted-foreground size-4" strokeWidth={1.5} aria-hidden />
        <h2 className="text-base font-semibold">{title}</h2>
      </header>
      <div className="flex-1 px-4 pb-3">{children}</div>
      {footer ? <div className="border-t px-4 py-2.5">{footer}</div> : null}
    </section>
  );
}

type RecentEntry = GroupedActivity<{
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date | string;
  actorId: string | null;
  actorSnapshot: unknown;
  title: string;
  href: string | null;
}>;

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { isAdmin, due, blocked, myWork, myTickets, recent, storage, searchHealth, empty } =
    loaderData;
  const demoFetcher = useFetcher<typeof action>();
  const demoResult = demoFetcher.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("nav.overview")}</h1>
          <p className="text-muted-foreground mt-1">{t("dashboard.subtitle")}</p>
        </div>
        <nav aria-label={t("dashboard.quickLinks")} className="flex flex-wrap items-center gap-2">
          {QUICK_LINKS.map(({ to, labelKey, icon: Icon }) => (
            <Link key={to} to={to} className={buttonVariants({ variant: "secondary" })}>
              <Icon aria-hidden />
              {t(labelKey)}
            </Link>
          ))}
        </nav>
      </div>

      {empty ? (
        <section className="shadow-surface-2 rounded-lg bg-[color-mix(in_oklab,var(--fluid-accent)_8%,var(--card))] p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="size-4" aria-hidden />
            {t("dashboard.empty.title")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("dashboard.empty.body")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/tasks/new">
                <ListTodo className="size-4" aria-hidden /> {t("dashboard.empty.newTask")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/projects/new">
                <FolderKanban className="size-4" aria-hidden /> {t("dashboard.empty.newProject")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/notes/new">
                <NotebookPen className="size-4" aria-hidden /> {t("dashboard.empty.newNote")}
              </Link>
            </Button>
            {isAdmin ? (
              <demoFetcher.Form method="post">
                <input type="hidden" name="intent" value="load-demo" />
                <Button type="submit" size="sm" disabled={demoFetcher.state !== "idle"}>
                  {demoFetcher.state !== "idle"
                    ? t("dashboard.demo.loading")
                    : t("dashboard.demo.load")}
                </Button>
              </demoFetcher.Form>
            ) : null}
          </div>
        </section>
      ) : null}

      {demoResult && "loaded" in demoResult && demoResult.loaded ? (
        <p className="text-muted-foreground mt-2 text-sm" role="status">
          {t("dashboard.demo.loaded", { created: demoResult.created, skipped: demoResult.skipped })}
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card
          title={t("dashboard.due.title")}
          icon={Clock}
          footer={
            <Link to="/tasks?due=today" className="text-muted-foreground text-xs hover:underline">
              {t("dashboard.due.allTasks")}
            </Link>
          }
        >
          {due.overdueCount > 0 ? (
            <p className="text-destructive mb-2 flex items-center gap-1.5 text-sm">
              <AlertTriangle className="size-4" aria-hidden />
              {t("dashboard.due.overdue", { count: due.overdueCount })}
            </p>
          ) : null}
          {due.dueToday.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">{t("dashboard.due.none")}</p>
          ) : (
            <ul className="divide-y">
              {due.dueToday.map((task) => (
                <li key={task.id} className="flex items-center gap-2 py-2">
                  <Link to={`/tasks/${task.id}`} className={ROW_LINK}>
                    {task.title}
                  </Link>
                  <StatusBadge kind="task" value={task.status} className="ml-auto" />
                </li>
              ))}
            </ul>
          )}
          {due.dueTodayCount > due.dueToday.length ? (
            <p className="text-muted-foreground pt-1 text-xs">
              {t("dashboard.due.more", { count: due.dueTodayCount - due.dueToday.length })}
            </p>
          ) : null}
        </Card>

        <Card
          title={t("dashboard.blocked.title")}
          icon={Ban}
          footer={
            <Link
              to="/tasks?status=BLOCKED"
              className="text-muted-foreground text-xs hover:underline"
            >
              {t("dashboard.blocked.link")}
            </Link>
          }
        >
          {blocked.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">{t("dashboard.blocked.none")}</p>
          ) : (
            <ul className="divide-y">
              {blocked.map((task) => (
                <li key={task.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <Link to={`/tasks/${task.id}`} className={ROW_LINK}>
                      {task.title}
                    </Link>
                    <StatusBadge kind="task" value={task.status} className="ml-auto" />
                  </div>
                  {task.openBlockers.length > 0 ? (
                    <p className="text-muted-foreground truncate text-xs">
                      {t("dashboard.blocked.waitingOn", {
                        titles: task.openBlockers.map((b) => b.title).join(", "),
                      })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t("dashboard.mine.title")}
          icon={ListTodo}
          footer={
            <Link to="/tasks?assignee=me" className="text-muted-foreground text-xs hover:underline">
              {t("dashboard.mine.link")}
            </Link>
          }
        >
          <p className="text-muted-foreground mb-2 text-sm">
            {t("dashboard.mine.summary", {
              tasks: myWork.taskCount,
              tickets: myTickets.ticketCount,
              effort: formatMinutes(locale, t, myWork.estimateMinutes),
            })}
          </p>
          {myWork.tasks.length + myTickets.tickets.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">{t("dashboard.mine.none")}</p>
          ) : (
            <ul className="divide-y">
              {myWork.tasks.map((task) => (
                <li key={task.id} className="flex items-center gap-2 py-2">
                  <ListTodo className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <Link to={`/tasks/${task.id}`} className={ROW_LINK}>
                    {task.title}
                  </Link>
                  {task.dueAt ? (
                    <span className="ml-auto shrink-0">
                      <DateCell value={task.dueAt} />
                    </span>
                  ) : null}
                </li>
              ))}
              {myTickets.tickets.map((ticket) => (
                <li key={ticket.id} className="flex items-center gap-2 py-2">
                  <Ticket className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <Link to={`/tickets/${ticket.id}`} className={ROW_LINK}>
                    {ticket.title}
                  </Link>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                    {ticketTypeLabel(locale, ticket.type)} ·{" "}
                    {ticketStatusLabel(locale, ticket.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t("dashboard.recent.title")}
          icon={History}
          footer={
            <Link to="/activity" className="text-muted-foreground text-xs hover:underline">
              {t("dashboard.recent.link")}
            </Link>
          }
        >
          {recent.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">{t("history.empty")}</p>
          ) : (
            <ul className="divide-y">
              {(recent as RecentEntry[]).map((e) => (
                <li key={e.id} className="flex min-w-0 items-center gap-2 py-2">
                  <span className="text-muted-foreground min-w-0 truncate">
                    {actionLabel(locale, e.action)}
                  </span>
                  {e.href ? (
                    <Link to={e.href} className={ROW_LINK}>
                      {e.title}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground truncate">{e.title}</span>
                  )}
                  {e.count > 1 ? (
                    <span className="text-muted-foreground nums text-xs">×{e.count}</span>
                  ) : null}
                  <Badge className="type-micro ml-auto h-5 rounded-full px-1.5 font-semibold">
                    {actorInitials(e.actorSnapshot, e.actorId)}
                  </Badge>
                  <span className="shrink-0">
                    <DateCell value={e.occurredAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("dashboard.storage.title")} icon={Building2}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 py-1">
            <dt className="text-muted-foreground">{t("dashboard.storage.attachments")}</dt>
            <dd className="nums">{storage.attachmentCount}</dd>
            <dt className="text-muted-foreground">{t("dashboard.storage.totalSize")}</dt>
            <dd className="nums">{formatBytes(locale, storage.totalBytes)}</dd>
            <dt className="text-muted-foreground">{t("dashboard.storage.backend")}</dt>
            <dd>{storage.backend}</dd>
            <dt className="text-muted-foreground">{t("dashboard.storage.index")}</dt>
            <dd>{searchHealth.note}</dd>
            {isAdmin ? (
              <>
                <dt className="text-muted-foreground"> </dt>
                <dd>
                  <Link to="/admin/index" className="text-muted-foreground text-xs hover:underline">
                    {t("dashboard.storage.indexLink")}
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
