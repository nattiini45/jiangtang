/**
 * Theme persistence (industrial default: dark). A `theme` cookie drives the
 * `.dark` class applied to <html> in root.tsx. Readable by the client so the
 * toggle can update immediately.
 */

export type Theme = "light" | "dark";

const COOKIE_NAME = "theme";
const ONE_YEAR = 60 * 60 * 24 * 365;

// `Secure` in production. The live writer today is the client toggle
// in app-shell.tsx (document.cookie); these Set-Cookie helpers are the server-set
// fallback for a future no-JS path, kept correct so wiring them is drop-in.
const SECURE = process.env.NODE_ENV === "production" ? "; Secure" : "";

export function getTheme(request: Request): Theme {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)theme=(light|dark)/);
  return (match?.[1] as Theme | undefined) ?? "dark";
}

export function setThemeCookie(theme: Theme): string {
  return `${COOKIE_NAME}=${theme}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${SECURE}`;
}

export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** Row density (comfortable/compact toggle). Default compact (technical). */
export type Density = "comfortable" | "compact";

export function getDensity(request: Request): Density {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)density=(comfortable|compact)/);
  return (match?.[1] as Density | undefined) ?? "compact";
}

export function setDensityCookie(density: Density): string {
  return `density=${density}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${SECURE}`;
}
