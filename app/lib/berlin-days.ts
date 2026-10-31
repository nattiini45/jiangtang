/**
 * Europe/Berlin *civil-day* math — client-safe (Intl only, no Node APIs), so it
 * can run in components, loaders and tests alike. A Berlin calendar day is not
 * always 24 h (2026-03-29 is 23 h, 2026-10-25 is 25 h), so "which day" and
 * "where does the day start" must go through the platform tz database, never
 * through fixed-offset arithmetic.
 *
 * Days are represented as a **day index**: the count of civil days since the
 * epoch as the Berlin calendar counts them. `berlinDayIndex` maps an instant
 * to its day; `berlinDayStartMs` maps a day back to the UTC instant its
 * midnight falls on. The pair is DST-correct by construction.
 */

export const BERLIN_TZ = "Europe/Berlin";

const DAY_MS = 86_400_000;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BERLIN_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const isoDateFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: BERLIN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localDateTimeFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: BERLIN_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Offset (ms) of Europe/Berlin from UTC at `ms`. Positive east of UTC. */
export function berlinOffsetMs(ms: number): number {
  const parts = partsFmt.formatToParts(new Date(ms));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  return Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second) - ms;
}

/** UTC instant → the Berlin civil day containing it, as a day index. */
export function berlinDayIndex(date: Date | number): number {
  const ms = typeof date === "number" ? date : date.getTime();
  return Math.floor((ms + berlinOffsetMs(ms)) / DAY_MS);
}

/** Berlin civil day index → the UTC instant of that day's midnight. Two-pass
 *  offset correction settles the answer inside DST-transition windows, the same
 *  approach `berlinLocalToUtc` uses for full datetimes. */
export function berlinDayStartMs(dayIndex: number): number {
  const naive = dayIndex * DAY_MS;
  const first = naive - berlinOffsetMs(naive);
  return naive - berlinOffsetMs(first);
}

/** UTC instant → "YYYY-MM-DD" on the Berlin calendar. */
export function berlinDateKey(date: Date | number): string {
  return isoDateFmt.format(typeof date === "number" ? new Date(date) : date);
}

/** UTC instant → "YYYY-MM-DD HH:mm" Berlin wall-clock — the client-safe twin
 *  of `utcToBerlinLocal` (time.server.ts is `.server`; components can't import
 *  it). Slice for parts: `slice(0,10)` = date, `slice(11,16)` = "HH:mm". */
export function berlinLocalString(date: Date | number | string): string {
  return localDateTimeFmt.format(typeof date === "object" ? date : new Date(date));
}

/** Berlin day index → "YYYY-MM-DD" (the civil date the index counts). */
export function dayIndexToDateKey(dayIndex: number): string {
  return berlinDateKey(berlinDayStartMs(dayIndex) + DAY_MS / 2);
}

/** Day index → ISO weekday, Monday = 1 … Sunday = 7. The epoch was a Thursday. */
export function isoWeekday(dayIndex: number): number {
  return (((dayIndex % 7) + 7 + 3) % 7) + 1;
}

/** The day index of the ISO week Monday containing `dayIndex`. */
export function isoWeekStart(dayIndex: number): number {
  return dayIndex - (isoWeekday(dayIndex) - 1);
}

/**
 * ISO week number + week-numbering year for a Berlin day index. ISO rule: week 1
 * holds the year's first Thursday. Pure civil-date math — the day index already
 * carries the timezone.
 */
export function isoWeekNumber(dayIndex: number): { year: number; week: number } {
  const thursday = dayIndex + (4 - isoWeekday(dayIndex));
  const { year } = civilFromDayIndex(thursday);
  const jan4 = dayIndexFromCivil(year, 1, 4);
  const week1Monday = isoWeekStart(jan4);
  return { year, week: Math.round((thursday - week1Monday) / 7) + 1 };
}

/** "2026-W41" → { startDay, endDay } as Berlin day indexes (Mon…Sun). */
export function isoWeekRange(isoWeek: string): { startDay: number; endDay: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek.trim());
  if (!m) throw new Error(`Ungültige ISO-Woche: ${isoWeek}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error(`Ungültige ISO-Woche: ${isoWeek}`);
  const startDay = isoWeekStart(dayIndexFromCivil(year, 1, 4)) + (week - 1) * 7;
  return { startDay, endDay: startDay + 6 };
}

/** The ISO week string ("2026-W41") containing a Berlin day index. */
export function dayIndexToIsoWeek(dayIndex: number): string {
  const { year, week } = isoWeekNumber(dayIndex);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// --- civil date ↔ day index (Howard Hinnant's algorithms, timezone-free) ---

export function civilFromDayIndex(z: number): { year: number; month: number; day: number } {
  const era = Math.floor((z + 719468) / 146097);
  const doe = z + 719468 - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: month <= 2 ? year + 1 : year, month, day };
}

export function dayIndexFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
