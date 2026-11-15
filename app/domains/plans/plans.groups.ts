import type { planOccurrences } from "./plans.queries.server";

type Occurrence = Awaited<ReturnType<typeof planOccurrences>>[number];

export function groupPlanOccurrences(rows: Occurrence[]) {
  const groups = new Map<string, Occurrence[]>();
  for (const row of rows) {
    const key = `${row.planId}:${+new Date(row.date)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group[0],
    count: group.length,
    device: group.length === 1 ? group[0].device : null,
    equipment: group.flatMap((row) => (row.device ? [row.device] : [])),
    rooms: [...new Map(group.flatMap((row) => row.rooms).map((room) => [room.id, room])).values()],
    href: group.length === 1 ? group[0].href : `/plans/${group[0].planId}`,
  }));
}
