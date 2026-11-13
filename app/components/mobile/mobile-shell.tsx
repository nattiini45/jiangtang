import * as React from "react";
import {
  Form,
  Link,
  NavLink,
  PrefetchPageLinks,
  useFetchers,
  useLocation,
  useNavigation,
} from "react-router";
import { motion } from "motion/react";
import {
  Bell,
  House,
  Building2,
  Ticket,
  MoreHorizontal,
  ListTodo,
  ChevronRight,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { spring } from "~/lib/springs";
import { useLiveRefetch } from "~/lib/realtime/use-live-refetch";
import { useOfflineQueue } from "~/lib/pwa/offline-queue";
import { QueueBadge } from "~/components/mobile/queue-badge";
import { NavPendingIndicator } from "~/components/states/nav-pending";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { ViewSwitch } from "~/components/layout/view-switch";
import { WeightLabel } from "~/components/ui/weight-label";
import type { MessageKey } from "~/i18n";
import { roleLabel } from "~/components/auth/labels";
import type { UserRole } from "~/generated/prisma/client";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile PWA shell. Its own design — single-column, big tap
 * targets, a bottom nav (Rooms / Tasks / Capture / Tickets / More). Distinct
 * from the desktop AppShell (no sidebar, no density toggle): it pins the default
 * size step, since a phone has no use for the compact one. Same Tailwind
 * tokens. The header carries the offline-queue pending badge.
 */
export interface MobileUser {
  name: string;
  initials?: string | null;
  role?: UserRole | null;
}

const NAV: { to: string; labelKey: MessageKey; icon: typeof Building2; end?: boolean }[] = [
  { to: "/m/rooms", labelKey: "nav.rooms", icon: Building2 },
  { to: "/m/tasks", labelKey: "nav.tasks", icon: ListTodo },
  { to: "/m", labelKey: "nav.overview", icon: House, end: true },
  { to: "/m/tickets", labelKey: "nav.tickets", icon: Ticket },
];

const MORE_LINKS: { to: string; labelKey: MessageKey }[] = [
  { to: "/m/quick-entry", labelKey: "mobile.nav.entry" },
  { to: "/m/rounds", labelKey: "functions.rounds.title" },
  { to: "/m/functions", labelKey: "functions.list.title" },
  { to: "/m/locations", labelKey: "nav.locations" },
  { to: "/m/inventory/stock", labelKey: "nav.stock" },
  { to: "/m/calendar", labelKey: "nav.calendar" },
  { to: "/m/events", labelKey: "nav.events" },
  { to: "/m/projects", labelKey: "nav.projects" },
  { to: "/m/notes", labelKey: "nav.notes" },
  { to: "/m/timesheet", labelKey: "nav.timesheet" },
  { to: "/m/board", labelKey: "nav.board" },
  { to: "/m/search", labelKey: "nav.search" },
];

const CREATE_LINKS: { to: string; labelKey: MessageKey }[] = [
  { to: "/m/tasks/new", labelKey: "mobile.menu.newTask" },
  { to: "/m/notes/new", labelKey: "mobile.menu.newNote" },
  { to: "/m/events/new", labelKey: "mobile.events.create" },
];

const TAB_CLASS =
  "relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-xs transition-colors duration-80";

export function MobileShell({
  user,
  unreadNotifications = 0,
  children,
}: {
  user: MobileUser;
  unreadNotifications?: number;
  children: React.ReactNode;
}) {
  // Same single SSE connection pattern as the desktop AppShell (real-time) —
  // any committed change in another session triggers a refetch.
  useLiveRefetch();
  const t = useT();
  const locale = useLocale();
  // Replays the capture queue on mount + `online`, and gives the badge.
  const { pending, authRequired } = useOfflineQueue();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [captureReady, setCaptureReady] = React.useState(false);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const moreRef = React.useRef<HTMLButtonElement>(null);
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const busy = navigation.state !== "idle" || fetchers.some((f) => f.state !== "idle");
  const { pathname } = useLocation();
  const moreActive =
    menuOpen || MORE_LINKS.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

  React.useEffect(() => {
    if (!("serviceWorker" in navigator) || !("controller" in navigator.serviceWorker)) return;
    const update = () => setCaptureReady(Boolean(navigator.serviceWorker.controller));
    update();
    navigator.serviceWorker.addEventListener("controllerchange", update);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", update);
  }, []);

  React.useEffect(() => {
    if (!menuOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = moreRef.current;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = overflow;
      trigger?.focus({ preventScroll: true });
    };
  }, [menuOpen]);

  // Hydration marker: e2e waits for `html[data-hydrated]` before interacting —
  // a pre-hydration submit falls back to a native POST, which offline turns
  // into a browser error page instead of the queued-capture flow.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <div
      data-density="comfortable"
      className="mobile-shell bg-background text-foreground flex min-h-screen flex-col text-sm"
    >
      <NavPendingIndicator />
      {captureReady ? <PrefetchPageLinks page="/m/quick-entry" /> : null}
      <p role="status" className="sr-only">
        {busy ? t("mobile.loading") : ""}
      </p>
      <header className="mobile-header bg-background/85 sticky top-0 z-20 flex items-center justify-between border-b backdrop-blur-md">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-foreground text-background flex size-7 items-center justify-center rounded-md text-sm font-bold"
          >
            J
          </span>
          <span className="font-semibold">Jiangtang</span>
        </span>
        <span className="flex items-center gap-2">
          <QueueBadge pending={pending} authRequired={authRequired} />
          <Link
            to="/m/notifications"
            aria-label={t("shell.notifications")}
            title={t("shell.notifications")}
            className="bg-card relative flex size-11 items-center justify-center rounded-md shadow-[inset_0_0_0_1px_var(--input)]"
          >
            <Bell className="size-4" strokeWidth={1.5} aria-hidden />
            {unreadNotifications > 0 ? (
              <span className="bg-destructive text-destructive-foreground nums type-micro absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full font-semibold">
                {unreadNotifications > 9 ? "9+" : unreadNotifications}
              </span>
            ) : null}
          </Link>
          <span className="bg-tint type-micro flex size-7 items-center justify-center rounded-full font-semibold">
            {user.initials ?? user.name.slice(0, 2)}
          </span>
        </span>
      </header>
      <main aria-busy={busy} className="min-w-0 flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {children}
      </main>

      <dialog
        ref={dialogRef}
        id="mobile-more"
        aria-labelledby="mobile-more-title"
        className="mobile-more bg-surface-5 text-foreground shadow-surface-5 rounded-xl p-0"
        onClose={() => setMenuOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const targets = event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          );
          const first = targets[0];
          const last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            setMenuOpen(false);
        }}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <h2 id="mobile-more-title" className="text-base font-semibold">
            {t("mobile.nav.more")}
          </h2>
          <button
            type="button"
            aria-label={t("mobile.menu.close")}
            onClick={() => setMenuOpen(false)}
            className="hover:bg-hover flex size-11 shrink-0 items-center justify-center rounded-md"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
          <div className="flex flex-col px-1">
            <span className="font-semibold">{user.name}</span>
            {user.role ? (
              <span className="text-muted-foreground text-xs">{roleLabel(locale, user.role)}</span>
            ) : null}
          </div>
          <nav aria-label={t("mobile.menu.moreSections")} className="flex flex-col gap-4">
            {[
              { label: t("mobile.menu.moreSections"), links: MORE_LINKS },
              { label: t("mobile.menu.create"), links: CREATE_LINKS },
            ].map((group) => (
              <section key={group.label} className="flex flex-col gap-2">
                <h3 className="text-muted-foreground px-1 font-semibold">{group.label}</h3>
                <div className="bg-card shadow-surface-1 flex flex-col divide-y overflow-hidden rounded-lg">
                  {group.links.map((l) => (
                    <Link
                      key={l.to}
                      to={l.to}
                      onClick={() => setMenuOpen(false)}
                      className="active:bg-selected flex min-h-12 items-center justify-between px-3 transition-colors duration-80"
                    >
                      {t(l.labelKey)}
                      <ChevronRight
                        className="text-muted-foreground size-4 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </nav>
          <div className="flex items-center justify-between gap-2">
            <LanguageSwitcher size="lg" className="bg-background" />
            <Form method="post" action="/logout">
              <button
                type="submit"
                className="bg-tint active:bg-tint-hover flex min-h-11 cursor-pointer items-center rounded-md px-4 font-semibold transition-colors duration-80"
              >
                {t("shell.logout")}
              </button>
            </Form>
          </div>
          <ViewSwitch
            view="desktop"
            className="text-muted-foreground flex min-h-11 w-full items-center justify-center text-xs underline decoration-(--input) underline-offset-4"
          >
            {t("mobile.menu.desktop")}
          </ViewSwitch>
        </div>
      </dialog>

      <nav className="mobile-tabs bg-background/90 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
        {NAV.map(({ to, labelKey, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              cn(TAB_CLASS, isActive && !menuOpen ? "text-foreground" : "text-muted-foreground")
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative flex h-7 w-12 items-center justify-center">
                  {isActive && !menuOpen ? (
                    <motion.span
                      layoutId="mobile-tab-active"
                      transition={spring.moderate}
                      className="bg-selected absolute inset-0 rounded-full"
                    />
                  ) : null}
                  <Icon
                    className="relative size-5"
                    strokeWidth={isActive && !menuOpen ? 2 : 1.5}
                    aria-hidden
                  />
                </span>
                <WeightLabel active={isActive && !menuOpen}>{t(labelKey)}</WeightLabel>
              </>
            )}
          </NavLink>
        ))}
        <button
          ref={moreRef}
          type="button"
          aria-haspopup="dialog"
          aria-controls="mobile-more"
          aria-current={moreActive ? "true" : undefined}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className={cn(TAB_CLASS, moreActive ? "text-foreground" : "text-muted-foreground")}
        >
          <span className="relative flex h-7 w-12 items-center justify-center">
            {moreActive ? (
              <motion.span
                layoutId="mobile-tab-active"
                transition={spring.moderate}
                className="bg-selected absolute inset-0 rounded-full"
              />
            ) : null}
            <MoreHorizontal
              className="relative size-5"
              strokeWidth={moreActive ? 2 : 1.5}
              aria-hidden
            />
          </span>
          <WeightLabel active={moreActive}>{t("mobile.nav.more")}</WeightLabel>
        </button>
      </nav>
    </div>
  );
}
