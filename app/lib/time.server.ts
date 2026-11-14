/**
 * Time helpers. The golden rule: ALL times are `Europe/Berlin` / `timestamptz`.
 * The database stores instants (timestamptz); these helpers convert between a
 * Berlin wall-clock string (what a user types into a `datetime-local` input) and
 * a UTC instant, and format instants for display — all DST-correct.
 */

export const BERLIN_TZ = "Europe/Berlin";

export function berlinNow(): Date {
  return new Date();
}

/**
 * Offset (ms) of `tz` from UTC at the moment `date`. Positive east of UTC
 * (Berlin is +1h winter / +2h summer). Uses Intl so DST is handled by the
 * platform's tz database — no hardcoded rules.
 */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Interpret a Berlin wall-clock string ("2026-07-01T10:00" or with seconds) as
 * the corresponding UTC instant. Two-pass to settle the DST offset at the target
 * instant (matters within the ~1h DST-transition windows).
 */
export function berlinLocalToUtc(local: string): Date {
  const naive = new Date(`${local.length === 16 ? `${local}:00` : local}Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`Invalid local datetime: ${local}`);
  }
  const firstGuess = new Date(naive.getTime() - tzOffsetMs(naive, BERLIN_TZ));
  // Re-evaluate the offset at the candidate instant and correct once.
  const corrected = new Date(naive.getTime() - tzOffsetMs(firstGuess, BERLIN_TZ));
  return corrected;
}

/** UTC instant → "YYYY-MM-DDTHH:mm" Berlin wall-clock (for datetime-local inputs). */
export function utcToBerlinLocal(
  date: Date,
  precision: "minute" | "millisecond" = "minute",
): string {
  const dtf = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BERLIN_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: precision === "millisecond" ? "2-digit" : undefined,
    fractionalSecondDigits: precision === "millisecond" ? 3 : undefined,
  });
  // sv-SE yields "YYYY-MM-DD HH:mm"; normalize the separator.
  return dtf.format(date).replace(" ", "T").replace(",", ".");
}
