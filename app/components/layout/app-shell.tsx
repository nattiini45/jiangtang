import * as React from "react";
import { Form, NavLink } from "react-router";
import { LogOut, Moon, Rows3, Rows4, Square, Sun } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { CommandPalette } from "~/components/command/command-palette";
import { useLiveRefetch } from "~/lib/realtime/use-live-refetch";
import { NavPendingIndicator } from "~/components/states/nav-pending";
import { NAV } from "~/components/layout/nav";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { useT } from "~/i18n/use-t";
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
  role?: string | null;
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

  // Hydration marker: e2e waits for `html[data-hydrated]` before interacting —
  // a click that lands before React attaches falls through to the native form
  // (same contract as the mobile shell).
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <div className="bg-background text-foreground min-h-screen">
      <NavPendingIndicator />
      <CommandPalette admin={user.role === "ADMIN"} />
      <div className="grid min-h-screen grid-cols-[220px_1fr]">
        <aside className="border-border bg-card flex flex-col border-r">
          <div className="border-border flex h-12 items-center border-b px-4">
            <span className="font-mono text-sm font-semibold tracking-tight">Jiangtang</span>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5 p-2">
            {NAV.filter((item) => !item.adminOnly || user.role === "ADMIN").map(
              ({ to, labelKey, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                      isActive
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  {t(labelKey)}
                </NavLink>
              ),
            )}
          </nav>
          <div className="border-border border-t p-3 text-xs">
            <p className="font-mono">{user.initials ?? user.name}</p>
            <p className="text-muted-foreground truncate">{user.email}</p>
          </div>
        </aside>

        <div className="flex min-h-screen flex-col">
          <header className="border-border bg-card flex h-12 items-center justify-between border-b px-4">
            <div className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
              {t("shell.workspace")} · {user.role ?? "MEMBER"}
            </div>
            <div className="flex items-center gap-1">
              {runningTimer ? <RunningTimerBadge timer={runningTimer} /> : null}
              <span
                className="text-muted-foreground mr-2 hidden items-center gap-1 font-mono text-xs sm:flex"
                title={t("shell.searchHint")}
              >
                {t("shell.search")}
                <kbd className="border-border bg-muted rounded-sm border px-1 py-0.5">⌘K</kbd>
              </span>
              <LanguageSwitcher className="mr-1" />
              <DensityToggle density={density} />
              <ThemeToggle theme={theme} />
              <Form method="post" action="/logout">
                <Button type="submit" variant="ghost" size="icon" title={t("shell.logout")}>
                  <LogOut className="size-4" />
                </Button>
              </Form>
            </div>
          </header>
          <main className="flex-1 p-4">{children}</main>
        </div>
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
    <Form method="post" action="/timesheet" className="flex items-center gap-1">
      <input type="hidden" name="_action" value="stop-timer" />
      <span
        className="text-muted-foreground flex items-center gap-1 font-mono text-xs"
        title={timer.taskTitle ?? t("shell.timer.running")}
      >
        <span className="bg-destructive inline-block size-2 animate-pulse rounded-full" />
        {Math.floor(elapsedMin / 60)}:{String(elapsedMin % 60).padStart(2, "0")}
        {timer.taskTitle ? <span className="max-w-[10rem] truncate">{timer.taskTitle}</span> : null}
      </span>
      <Button type="submit" variant="ghost" size="icon" title={t("shell.timer.stop")}>
        <Square className="size-4" />
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
  return (
    <Button type="button" variant="ghost" size="icon" onClick={cycleTheme} title={t("shell.theme")}>
      {current === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
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
    >
      {current === "compact" ? <Rows3 className="size-4" /> : <Rows4 className="size-4" />}
    </Button>
  );
}
