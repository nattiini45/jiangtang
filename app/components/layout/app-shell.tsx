import * as React from "react";
import { Form, Link, NavLink } from "react-router";
import { motion } from "motion/react";
import { LogOut, Monitor, Moon, Plus, Rows3, Rows4, Search, Square, Sun } from "lucide-react";
import { cn } from "~/lib/utils";
import { spring } from "~/lib/springs";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/badge";
import { FluidHoverHighlight, useFluidHover } from "~/components/ui/fluid-hover";
import { WeightLabel } from "~/components/ui/weight-label";
import { CommandPalette, OPEN_PALETTE_EVENT } from "~/components/command/command-palette";
import { useLiveRefetch } from "~/lib/realtime/use-live-refetch";
import { NavPendingIndicator } from "~/components/states/nav-pending";
import { NAV, NAV_GROUPS, type NavEntry } from "~/components/layout/nav";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { roleLabel } from "~/components/auth/labels";
import type { UserRole } from "~/generated/prisma/client";
import { useLocale, useT } from "~/i18n/use-t";
import {
  PREF_CHANGED_EVENT,
  currentDensity,
  currentTheme,
  cycleDensity,
  cycleTheme,
} from "~/lib/prefs";
import type { Density, Theme } from "~/lib/theme.server";

export interface ShellUser {
  name: string;
  email: string;
  role?: UserRole | null;
  initials?: string | null;
}

export interface RunningTimer {
  id: string;
  startsAt: string;
  taskTitle: string | null;
}

export function AppShell({
  user,
  theme,
  density,
  runningTimer = null,
  children,
}: {
  user: ShellUser;
  theme: Theme;
  density: Density;
  runningTimer?: RunningTimer | null;
  children: React.ReactNode;
}) {
  // One SSE connection for the whole desktop surface; any committed change in
  // another session triggers a refetch here (real-time).
  useLiveRefetch();
  const t = useT();
  const locale = useLocale();

  // Hydration marker: e2e waits for `html[data-hydrated]` before interacting —
  // a click that lands before React attaches falls through to the native form
  // (same contract as the mobile shell).
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  const visible = NAV.filter((item) => !item.adminOnly || user.role === "ADMIN");

  return (
    <div className="bg-background text-foreground min-h-screen">
      <NavPendingIndicator />
      <CommandPalette admin={user.role === "ADMIN"} />
      <div className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)]">
        <aside className="sticky top-0 flex h-screen flex-col border-r">
          <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
            <span
              aria-hidden
              className="bg-foreground text-background flex size-7 items-center justify-center rounded-md text-sm font-bold"
            >
              J
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">Jiangtang</span>
              <span className="text-muted-foreground truncate text-xs">{t("shell.workspace")}</span>
            </span>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-4">
            {NAV_GROUPS.map((group) => {
              const items = visible.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              return <NavSection key={group.id} label={t(group.labelKey)} items={items} />;
            })}
          </nav>
          <div
            className="flex shrink-0 items-center gap-2.5 border-t px-4 py-3"
            title={user.role ? roleLabel(locale, user.role) : undefined}
          >
            <span
              aria-hidden
              className="bg-tint type-micro flex size-7 shrink-0 items-center justify-center rounded-full font-semibold"
            >
              {user.initials ?? user.name.slice(0, 2)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </span>
          </div>
        </aside>

        <div className="flex min-h-screen min-w-0 flex-col">
          <header className="bg-background/85 sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b px-6 backdrop-blur-md">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}
              title={t("shell.searchHint")}
              className="text-muted-foreground hover:text-foreground bg-card flex h-8 w-full max-w-72 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm shadow-[inset_0_0_0_1px_var(--input)] transition-colors duration-80"
            >
              <Search className="size-4 shrink-0" strokeWidth={1.5} />
              <span className="flex-1 text-left">{t("shell.search")}</span>
              <Kbd>⌘K</Kbd>
            </button>
            <div className="flex items-center gap-1">
              <Button
                asChild
                size="icon"
                className="mr-1"
                title={t("shell.quickEntry")}
                aria-label={t("shell.quickEntry")}
              >
                <Link to="/quick-entry">
                  <Plus />
                </Link>
              </Button>
              {runningTimer ? <RunningTimerBadge timer={runningTimer} /> : null}
              <LanguageSwitcher className="mr-1" />
              <DensityToggle density={density} />
              <ThemeToggle theme={theme} />
              <Form method="post" action="/logout">
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  title={t("shell.logout")}
                  aria-label={t("shell.logout")}
                >
                  <LogOut />
                </Button>
              </Form>
            </div>
          </header>
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

/**
 * One nav group: its own hover scope, so the highlight never glides across a
 * group label. The selected background is shared across groups through
 * `layoutId` and glides to the new row on navigation.
 */
function NavSection({ label, items }: { label: string; items: NavEntry[] }) {
  const t = useT();
  const hover = useFluidHover<HTMLDivElement>();
  return (
    <div className="pt-4 first:pt-1">
      <p className="text-muted-foreground px-2 pb-1 text-xs">{label}</p>
      <div ref={hover.containerRef} {...hover.handlers} className="relative">
        <FluidHoverHighlight hover={hover} />
        <ul className="flex flex-col">
          {items.map(({ to, labelKey, icon: Icon, end }, index) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                {...hover.itemProps(index)}
                className={({ isActive }) =>
                  cn(
                    "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-80",
                    isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <motion.span
                        layoutId="desktop-nav-active"
                        transition={spring.moderate}
                        className="bg-selected absolute inset-0 rounded-md"
                      />
                    ) : null}
                    <Icon
                      className="relative size-4 shrink-0"
                      strokeWidth={isActive ? 2 : 1.5}
                      aria-hidden
                    />
                    <WeightLabel active={isActive} className="relative">
                      {t(labelKey)}
                    </WeightLabel>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Running-timer chip in the header: elapsed h:mm ticking once a minute,
 * plus a stop button that posts straight to the timesheet action. `elapsed` is
 * derived from `startsAt` — a revalidation replaces the prop, the interval
 * keeps rendering off the new base.
 */
function RunningTimerBadge({ timer }: { timer: RunningTimer }) {
  const t = useT();
  const [elapsedMin, setElapsedMin] = React.useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(timer.startsAt).getTime()) / 60_000)),
  );
  React.useEffect(() => {
    const start = new Date(timer.startsAt).getTime();
    const tick = () => setElapsedMin(Math.max(0, Math.floor((Date.now() - start) / 60_000)));
    const id = setInterval(tick, 15_000);
    tick();
    return () => clearInterval(id);
  }, [timer.startsAt]);

  return (
    <Form
      method="post"
      action="/timesheet"
      className="bg-tint mr-2 flex h-8 items-center gap-2 rounded-full pr-0.5 pl-3"
    >
      <input type="hidden" name="_action" value="stop-timer" />
      <span
        className="flex items-center gap-2 text-xs"
        title={timer.taskTitle ?? t("shell.timer.running")}
      >
        <span className="bg-destructive inline-block size-2 animate-pulse rounded-full motion-reduce:animate-none" />
        <span className="nums font-semibold">
          {Math.floor(elapsedMin / 60)}:{String(elapsedMin % 60).padStart(2, "0")}
        </span>
        {timer.taskTitle ? (
          <span className="text-muted-foreground max-w-[10rem] truncate">{timer.taskTitle}</span>
        ) : null}
      </span>
      <Button
        type="submit"
        variant="ghost"
        size="icon-compact"
        className="rounded-full before:rounded-full"
        title={t("shell.timer.stop")}
        aria-label={t("shell.timer.stop")}
      >
        <Square />
      </Button>
    </Form>
  );
}

// The toggles cycle through `app/lib/prefs` — the same functions the command
// palette's verbs call — and resync their icon state on PREF_CHANGED_EVENT so
// a palette-triggered toggle updates the header buttons too.
function ThemeToggle({ theme }: { theme: Theme }) {
  const t = useT();
  const [current, setCurrent] = React.useState<Theme>(theme);
  React.useEffect(() => {
    const sync = () => setCurrent(currentTheme());
    window.addEventListener(PREF_CHANGED_EVENT, sync);
    return () => window.removeEventListener(PREF_CHANGED_EVENT, sync);
  }, []);
  const label = t("shell.themeState", { theme: t(`shell.theme.${current}`) });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      title={label}
      aria-label={label}
    >
      {current === "dark" ? <Moon /> : current === "light" ? <Sun /> : <Monitor />}
    </Button>
  );
}

function DensityToggle({ density }: { density: Density }) {
  const t = useT();
  const [current, setCurrent] = React.useState<Density>(density);
  React.useEffect(() => {
    const sync = () => setCurrent(currentDensity());
    window.addEventListener(PREF_CHANGED_EVENT, sync);
    return () => window.removeEventListener(PREF_CHANGED_EVENT, sync);
  }, []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={cycleDensity}
      title={t("shell.density")}
      aria-label={t("shell.density")}
    >
      {current === "compact" ? <Rows4 /> : <Rows3 />}
    </Button>
  );
}
