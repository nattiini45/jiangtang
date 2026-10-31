import type { Locale } from "./locales";
import { localeTag } from "./locales";

/** Every user-visible instant is shown on the Berlin wall clock, whatever the UI language. */
export const DISPLAY_TIME_ZONE = "Europe/Berlin";

export type DateInput = Date | string | number;

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function dateTimeFormat(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let fmt = dateTimeFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(localeTag(locale), {
      ...options,
      timeZone: DISPLAY_TIME_ZONE,
    });
    dateTimeFormats.set(key, fmt);
  }
  return fmt;
}

/** Format an instant with arbitrary `Intl` options, always in Europe/Berlin. */
export function formatDateWith(
  locale: Locale,
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
): string {
  return dateTimeFormat(locale, options).format(new Date(value));
}

export function formatDate(locale: Locale, value: DateInput): string {
  return formatDateWith(locale, value, { dateStyle: "medium" });
}

export function formatDateTime(locale: Locale, value: DateInput): string {
  return formatDateWith(locale, value, { dateStyle: "medium", timeStyle: "short" });
}

/** Wall-clock time "HH:mm" in Berlin. */
export function formatTime(locale: Locale, value: DateInput): string {
  return formatDateWith(locale, value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "start – end", both as date + time. */
export function formatRange(locale: Locale, start: DateInput, end: DateInput): string {
  return `${formatDateTime(locale, start)} – ${formatDateTime(locale, end)}`;
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const key = `${locale}|${JSON.stringify(options ?? {})}`;
  let fmt = numberFormats.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(localeTag(locale), options);
    numberFormats.set(key, fmt);
  }
  return fmt.format(value);
}
