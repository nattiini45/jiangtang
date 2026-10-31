import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { TaskStatus, TicketStatus } from "~/generated/prisma/enums";
import {
  LANES,
  LANE_TASK_STATUSES,
  LANE_TICKET_STATUSES,
  laneOfTaskStatus,
  laneOfTicketStatus,
  TASK_LANE_DEFAULT_STATUS,
  TICKET_LANE_STATUS,
} from "../tasks.lanes";

/**
 * `tasks.lanes.ts` is the TypeScript MIRROR of the `workitem_lane` table — a
 * hand-folded, deliberately editable mapping that
 * Prisma does not model. This test is the contract that keeps the mirror
 * honest: it reads the table and asserts the TS constants equal it **exactly**,
 * so re-mapping a lane row reddens the suite instead of drifting silently.
 */
afterAll(async () => {
  await db.$disconnect();
});

describe("workitem_lane ⇄ tasks.lanes.ts", () => {
  it("the TS mapping equals the table exactly — same lanes, same statuses per lane", async () => {
    const rows = await db.$queryRaw<
      Array<{ lane: string; task_statuses: string[]; ticket_statuses: string[] }>
    >(Prisma.sql`SELECT lane, task_statuses, ticket_statuses FROM "workitem_lane"`);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.lane).sort()).toEqual([...LANES].sort());

    for (const row of rows) {
      const lane = row.lane as (typeof LANES)[number];
      expect(LANES).toContain(lane);
      expect([...row.task_statuses].sort()).toEqual([...LANE_TASK_STATUSES[lane]].sort());
      // The ticket side mirrors exactly too — including IN_REVIEW's
      // deliberately empty array: tickets have no review column.
      expect([...row.ticket_statuses].sort()).toEqual([...LANE_TICKET_STATUSES[lane]].sort());
    }

    // And the mirror is total in the other direction: every TaskStatus maps
    // into the lane the table gives it — nothing falls off the board.
    for (const status of Object.values(TaskStatus)) {
      const lane = laneOfTaskStatus(status);
      const row = rows.find((r) => r.lane === lane)!;
      expect(row.task_statuses).toContain(status);
    }
    for (const status of Object.values(TicketStatus)) {
      const lane = laneOfTicketStatus(status);
      const row = rows.find((r) => r.lane === lane)!;
      expect(row.ticket_statuses).toContain(status);
    }
  });

  it("every ticket lane target is a member of its own lane — and IN_REVIEW has none", async () => {
    const rows = await db.$queryRaw<Array<{ lane: string; ticket_statuses: string[] }>>(
      Prisma.sql`SELECT lane, ticket_statuses FROM "workitem_lane"`,
    );
    for (const lane of LANES) {
      const row = rows.find((r) => r.lane === lane)!;
      const target = TICKET_LANE_STATUS[lane];
      if (target === undefined) {
        expect(row.ticket_statuses).toEqual([]);
      } else {
        expect(row.ticket_statuses).toContain(target);
      }
    }
    expect(TICKET_LANE_STATUS.IN_REVIEW).toBeUndefined();
  });

  it("every lane default status is a member of its own lane", async () => {
    const rows = await db.$queryRaw<Array<{ lane: string; task_statuses: string[] }>>(
      Prisma.sql`SELECT lane, task_statuses FROM "workitem_lane"`,
    );
    for (const lane of LANES) {
      const row = rows.find((r) => r.lane === lane)!;
      expect(row.task_statuses).toContain(TASK_LANE_DEFAULT_STATUS[lane]);
    }
  });
});
