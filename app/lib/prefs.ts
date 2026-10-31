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

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function currentDensity(): Density {
  return document.documentElement.dataset.density === "compact" ? "compact" : "comfortable";
}

export function cycleTheme(): void {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", next === "dark");
  writePrefCookie("theme", next);
  window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
}

export function cycleDensity(): void {
  const next: Density = currentDensity() === "compact" ? "comfortable" : "compact";
  document.documentElement.dataset.density = next;
  writePrefCookie("density", next);
  window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
}
