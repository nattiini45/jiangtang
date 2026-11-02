import type { Density, Theme } from "~/lib/theme.server";

/**
 * Theme/density toggling — one implementation shared by the app-shell header
 * buttons and the command-palette verbs. Both functions flip the DOM
 * attribute + the preference cookie and then dispatch `PREF_CHANGED_EVENT` so
 * every rendered control (header button icons, the palette) resyncs its local
 * state from the DOM — the verb path and the button path can never diverge.
 */

export const PREF_CHANGED_EVENT = "jiangtang:pref-changed";

// Persist a UI-preference cookie. Adds `Secure` on HTTPS so it isn't
// re-sent over plain HTTP; harmlessly omitted on local http://localhost dev.
function writePrefCookie(name: string, value: string): void {
  const secure =
    typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

/** The chosen theme, `system` included; the `.dark` class only says what is shown. */
export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

export function currentDensity(): Density {
  return document.documentElement.dataset.density === "compact" ? "compact" : "comfortable";
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Light, then dark, then back to following the system. */
export function cycleTheme(): void {
  const current = currentTheme();
  const next: Theme = current === "light" ? "dark" : current === "dark" ? "system" : "light";
  const root = document.documentElement;
  root.dataset.theme = next;
  root.classList.toggle("dark", next === "dark" || (next === "system" && systemPrefersDark()));
  writePrefCookie("theme", next);
  window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
}

export function cycleDensity(): void {
  const next: Density = currentDensity() === "compact" ? "comfortable" : "compact";
  document.documentElement.dataset.density = next;
  writePrefCookie("density", next);
  window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
}
