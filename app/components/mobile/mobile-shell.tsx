import * as React from "react";
import { Form, Link, NavLink } from "react-router";
import { Camera, Building2, Ticket, MoreHorizontal, ListTodo, CloudOff } from "lucide-react";
import { cn } from "~/lib/utils";
import { useLiveRefetch } from "~/lib/realtime/use-live-refetch";
import { useOfflineQueue } from "~/lib/pwa/offline-queue";
import { NavPendingIndicator } from "~/components/states/nav-pending";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import type { MessageKey } from "~/i18n";
import { roleLabel } from "~/components/auth/labels";
import type { UserRole } from "~/generated/prisma/client";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile PWA shell. Its own design — single-column, big tap
 * targets, a bottom nav (Rooms / Tasks / Capture / Tickets / More). Distinct
 * from the desktop AppShell (no sidebar, no density toggle). Same Tailwind
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

const MORE_LINKS: { to: string; labelKey: MessageKey }[] = [
  { to: "/m/tasks/new", labelKey: "mobile.menu.newTask" },
  { to: "/m/notes/new", labelKey: "mobile.menu.newNote" },
  { to: "/m/board", labelKey: "nav.board" },
  { to: "/m/search", labelKey: "nav.search" },
];

export function MobileShell({ user, children }: { user: MobileUser; children: React.ReactNode }) {
  // Same single SSE connection pattern as the desktop AppShell (real-time) —
  // any committed change in another session triggers a refetch.
  useLiveRefetch();
  const t = useT();
  const locale = useLocale();
  // Replays the capture queue on mount + `online`, and gives the badge.
  const { pending } = useOfflineQueue();
  const [menuOpen, setMenuOpen] = React.useState(false);

  // Hydration marker: e2e waits for `html[data-hydrated]` before interacting —
  // a pre-hydration submit falls back to a native POST, which offline turns
  // into a browser error page instead of the queued-capture flow.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <NavPendingIndicator />
      <header className="border-border bg-card flex h-12 items-center justify-between border-b px-4">
        <span className="font-mono text-sm font-semibold">Jiangtang</span>
        <span className="flex items-center gap-2">
          {pending > 0 ? (
            <span
              role="status"
              className="bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-xs"
              title={t("mobile.offlinePending")}
            >
              <CloudOff className="size-3.5" />
              {pending}
            </span>
          ) : null}
          <span className="text-muted-foreground font-mono text-xs">
            {user.initials ?? user.name}
          </span>
        </span>
      </header>
      <main className="flex-1 overflow-y-auto pb-16">{children}</main>

      {/* "More" menu — language, logout (no dedicated mobile control before) + a small
          desktop escape hatch. A backdrop closes it on outside tap. */}
      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label={t("mobile.menu.close")}
            className="fixed inset-0 z-10 bg-black/40"
            onClick={() => setMenuOpen(false)}
          />
          <div className="border-border bg-card fixed inset-x-0 bottom-16 z-20 flex flex-col gap-1 border-t p-3">
            <span className="text-muted-foreground font-mono text-xs">
              {user.name}
              {user.role ? ` · ${roleLabel(locale, user.role)}` : ""}
            </span>
            <nav className="flex flex-col gap-1" aria-label={t("mobile.menu.moreSections")}>
              {MORE_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={() => setMenuOpen(false)}
                  className="border-border flex min-h-11 items-center rounded-sm border px-3 text-sm"
                >
                  {t(l.labelKey)}
                </Link>
              ))}
            </nav>
            <LanguageSwitcher size="lg" className="self-start" />
            <Form method="post" action="/logout">
              <button
                type="submit"
                className="border-border flex min-h-11 w-full items-center rounded-sm border px-3 text-sm"
              >
                {t("shell.logout")}
              </button>
            </Form>
            <Link
              to="/"
              onClick={() => setMenuOpen(false)}
              className="text-muted-foreground flex min-h-11 items-center px-3 text-xs underline"
            >
              {t("mobile.menu.desktop")}
            </Link>
          </div>
        </>
      ) : null}

      <nav className="border-border bg-card fixed inset-x-0 bottom-0 z-20 flex h-16 border-t">
        {NAV.map(({ to, labelKey, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs",
                isActive ? "text-primary" : "text-muted-foreground",
              )
            }
          >
            <Icon className="size-6" />
            {t(labelKey)}
          </NavLink>
        ))}
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs",
            menuOpen ? "text-primary" : "text-muted-foreground",
          )}
        >
          <MoreHorizontal className="size-6" />
          {t("mobile.nav.more")}
        </button>
      </nav>
    </div>
  );
}
