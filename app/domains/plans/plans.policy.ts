import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";

export function planDay(date: Date) {
  return new Date(berlinDayStartMs(berlinDayIndex(date)));
}

export function nextPlanDate(actual: Date, months: number) {
  const [year, month, day] = dayIndexToDateKey(berlinDayIndex(actual)).split("-").map(Number);
  const end = new Date(Date.UTC(year, month - 1 + months + 1, 0));
  const date = new Date(Date.UTC(year, month - 1 + months, Math.min(day, end.getUTCDate())));
  return new Date(berlinDayStartMs(Math.floor(+date / 86_400_000)));
}
