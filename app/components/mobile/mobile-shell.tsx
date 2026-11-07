import * as React from "react";
import { Form, Link, NavLink } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Building2, Ticket, MoreHorizontal, ListTodo, ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";
import { spring } from "~/lib/springs";
import { useLiveRefetch } from "~/lib/realtime/use-live-refetch";
import { useOfflineQueue } from "~/lib/pwa/offline-queue";
import { QueueBadge } from "~/components/mobile/queue-badge";
import { NavPendingIndicator } from "~/components/states/nav-pending";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
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
  { to: "/m", labelKey: "mobile.nav.entry", icon: Camera, end: true },
  { to: "/m/tickets", labelKey: "nav.tickets", icon: Ticket },
];

// The More sheet is a flat, single-level list of every mobile section — no
// nested groups, so every entry is one tap away.
const MORE_LINKS: { to: string; labelKey: MessageKey }[] = [
  { to: "/m/rooms", labelKey: "nav.rooms" },
  { to: "/m/locations", labelKey: "nav.locations" },
  { to: "/m/inventory/stock", labelKey: "nav.stock" },
  { to: "/m/events", labelKey: "nav.events" },
  { to: "/m/projects", labelKey: "nav.projects" },
  { to: "/m/notes", labelKey: "nav.notes" },
  { to: "/m/timesheet", labelKey: "nav.timesheet" },
  { to: "/m/board", labelKey: "nav.board" },
  { to: "/m/search", labelKey: "nav.search" },
  { to: "/m/tasks/new", labelKey: "mobile.menu.newTask" },
  { to: "/m/notes/new", labelKey: "mobile.menu.newNote" },
];

const TAB_CLASS =
  "relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-xs transition-colors duration-80";

export function MobileShell({ user, children }: { user: MobileUser; children: React.ReactNode }) {
  // Same single SSE connection pattern as the desktop AppShell (real-time) —
  // any committed change in another session triggers a refetch.
  useLiveRefetch();
  const t = useT();
  const locale = useLocale();
  // Replays the capture queue on mount + `online`, and gives the badge.
  const { pending, authRequired } = useOfflineQueue();
  const [menuOpen, setMenuOpen] = React.useState(false);

  // Hydration marker: e2e waits for `html[data-hydrated]` before interacting —
  // a pre-hydration submit falls back to a native POST, which offline turns
  // into a browser error page instead of the queued-capture flow.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <div
      data-density="comfortable"
      className="bg-background text-foreground flex min-h-screen flex-col text-sm"
    >
      <NavPendingIndicator />
      <header className="bg-background/85 sticky top-0 z-20 flex h-14 items-center justify-between border-b px-4 backdrop-blur-md">
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
          <span className="bg-tint type-micro flex size-7 items-center justify-center rounded-full font-semibold">
            {user.initials ?? user.name.slice(0, 2)}
          </span>
        </span>
      </header>
      <main className="flex-1 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </main>

      {/* "More" menu — language, logout (no dedicated mobile control before) + a small
          desktop escape hatch. A sheet over a backdrop that closes it on outside tap. */}
      <AnimatePresence>
        {menuOpen ? (
          <>
            <motion.button
              key="backdrop"
              type="button"
              aria-label={t("mobile.menu.close")}
              className="fixed inset-0 z-30 bg-black/30 dark:bg-black/50"
              onClick={() => setMenuOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: spring.slow.exit }}
              transition={spring.slow}
            />
            <motion.div
              key="sheet"
              className="bg-surface-5 shadow-surface-5 fixed inset-x-2 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex flex-col gap-3 rounded-xl p-3"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16, transition: spring.slow.exit }}
              transition={spring.slow}
            >
              <div className="flex flex-col px-1">
                <span className="font-semibold">{user.name}</span>
                {user.role ? (
                  <span className="text-muted-foreground text-xs">
                    {roleLabel(locale, user.role)}
                  </span>
                ) : null}
              </div>
              <nav
                className="bg-card shadow-surface-1 flex flex-col divide-y overflow-hidden rounded-lg"
                aria-label={t("mobile.menu.moreSections")}
              >
                {MORE_LINKS.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    onClick={() => setMenuOpen(false)}
                    className="active:bg-selected flex min-h-12 items-center justify-between px-3 transition-colors duration-80"
                  >
                    {t(l.labelKey)}
                    <ChevronRight className="text-muted-foreground size-4" strokeWidth={1.5} />
                  </Link>
                ))}
              </nav>
              <div className="flex items-center justify-between gap-2">
                <LanguageSwitcher size="lg" />
                <Form method="post" action="/logout">
                  <button
                    type="submit"
                    className="bg-tint active:bg-tint-hover flex min-h-11 cursor-pointer items-center rounded-md px-4 font-semibold transition-colors duration-80"
                  >
                    {t("shell.logout")}
                  </button>
                </Form>
              </div>
              <Link
                to="/"
                onClick={() => setMenuOpen(false)}
                className="text-muted-foreground flex min-h-11 items-center justify-center text-xs underline decoration-(--input) underline-offset-4"
              >
                {t("mobile.menu.desktop")}
              </Link>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      <nav className="bg-background/90 fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
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
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className={cn(TAB_CLASS, menuOpen ? "text-foreground" : "text-muted-foreground")}
        >
          <span className="relative flex h-7 w-12 items-center justify-center">
            {menuOpen ? (
              <motion.span
                layoutId="mobile-tab-active"
                transition={spring.moderate}
                className="bg-selected absolute inset-0 rounded-full"
              />
            ) : null}
            <MoreHorizontal
              className="relative size-5"
              strokeWidth={menuOpen ? 2 : 1.5}
              aria-hidden
            />
          </span>
          <WeightLabel active={menuOpen}>{t("mobile.nav.more")}</WeightLabel>
        </button>
      </nav>
    </div>
  );
}
