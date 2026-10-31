/**
 * Client-safe date formatting (no server-only imports — runs in both the SSR pass
 * and the browser, since Intl is universal). The golden rule is all times are
 * Europe/Berlin; `<input type="date">` prefills must therefore use the Berlin
 * calendar day, not a UTC one.
 */

const berlinDateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * UTC instant → "YYYY-MM-DD" Berlin wall-clock date for `<input type="date">`.
 * Anchored to Europe/Berlin so an early-morning instant (e.g. 00:30 Berlin =
 * 22:30Z the previous day) doesn't slip to the wrong calendar day the way a UTC
 * `toISOString().slice(0,10)` would. sv-SE renders ISO "YYYY-MM-DD".
 */
export function berlinDateInput(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(d.getTime()) ? "" : berlinDateFmt.format(d);
}
