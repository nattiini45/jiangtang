/**
 * `groupActivity` — collapses the feed's repetitive runs into one entry.
 * Consecutive rows with the same actor + entity + action, each within
 * `WINDOW_MS` (15 min) of the row before it, fold into the newest row of the
 * run with a `count`. Autosave is the motivating case: one editing session
 * writes many `NoteUpdated` rows that would otherwise flood `/activity`.
 *
 * Pure and client-safe — `occurredAt` accepts the ISO string a loader returns
 * after serialization, not just a `Date`.
 */
export interface GroupableActivity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date | string;
  actorId: string | null;
}

export type GroupedActivity<T extends GroupableActivity> = T & { count: number };

export const GROUP_WINDOW_MS = 15 * 60 * 1000;

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

export function groupActivity<T extends GroupableActivity>(rows: T[]): GroupedActivity<T>[] {
  const out: GroupedActivity<T>[] = [];
  let prev: GroupableActivity | null = null;
  for (const row of rows) {
    const sameRun =
      prev !== null &&
      prev.action === row.action &&
      prev.entityType === row.entityType &&
      prev.entityId === row.entityId &&
      prev.actorId === row.actorId &&
      ms(prev.occurredAt) - ms(row.occurredAt) <= GROUP_WINDOW_MS;
    if (sameRun) {
      out[out.length - 1].count += 1;
    } else {
      out.push({ ...row, count: 1 });
    }
    prev = row;
  }
  return out;
}
