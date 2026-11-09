import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import {
  createTicket,
  moveTicketToLane,
  transitionTicket,
} from "~/domains/tickets/tickets.mutations.server";
import type { TicketStatus } from "~/generated/prisma/client";

const actor = { id: null, name: "Transition characterization" };
const ids: string[] = [];
const statuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"] as const;
const graph: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CANCELLED"],
  RESOLVED: ["OPEN", "IN_PROGRESS"],
  CANCELLED: ["OPEN", "IN_PROGRESS"],
};
const verbs = {
  OPEN: "TicketReopened",
  IN_PROGRESS: "TicketStarted",
  RESOLVED: "TicketResolved",
  CANCELLED: "TicketCancelled",
};
const occurredAt = new Date("2026-02-03T12:00:00.000Z");

async function make(status: TicketStatus) {
  const ticket = await createTicket(actor, {
    title: `Synthetic transition ${status}`,
    type: "REQUEST",
    status,
    resolution: "Original payload",
    occurredAt,
    assigneeIds: [],
  });
  ids.push(ticket.id);
  return ticket;
}

const audits = (id: string) =>
  db.activityLog.findMany({ where: { entityType: "ticket", entityId: id } });

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("ticket lifecycle characterization", () => {
  for (const from of statuses) {
    for (const to of statuses) {
      it(`${from} → ${to}: state, payload and exact audit`, async () => {
        const before = await make(from);
        const logsBefore = await audits(before.id);
        if (!graph[from].includes(to)) {
          await expect(
            transitionTicket(actor, before.id, { status: to, resolution: "New payload" }),
          ).rejects.toBeInstanceOf(ValidationError);
          expect(await db.ticket.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
          expect(await audits(before.id)).toEqual(logsBefore);
          return;
        }
        const after = await transitionTicket(actor, before.id, {
          status: to,
          resolution: "New payload",
        });
        expect(after.status).toBe(to);
        expect(after.type).toBe("REQUEST");
        if (to === "RESOLVED") {
          expect(after.resolution).toBe("New payload");
          expect(after.resolvedAt).toBeInstanceOf(Date);
        } else if (to === "CANCELLED") {
          expect(after.resolution).toBe(before.resolution);
          expect(after.resolvedAt).toEqual(before.resolvedAt);
        } else {
          expect(after.resolution).toBeNull();
          expect(after.resolvedAt).toBeNull();
        }
        const logs = await audits(before.id);
        expect(logs).toHaveLength(logsBefore.length + 1);
        expect(logs.find((log) => !logsBefore.some((old) => old.id === log.id))).toMatchObject({
          action: verbs[to],
          data: { from, to },
        });
      });
    }
    it(`${from}: creation keeps current semantics and board same-lane is an unaudited no-op`, async () => {
      const before = await make(from);
      expect(before.resolution).toBe("Original payload");
      expect(before.resolvedAt).toEqual(from === "RESOLVED" ? occurredAt : null);
      const logs = await audits(before.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe(from === "RESOLVED" ? "TicketResolved" : "TicketCreated");
      const lanes = {
        OPEN: "BACKLOG",
        IN_PROGRESS: "IN_PROGRESS",
        RESOLVED: "DONE",
        CANCELLED: "CANCELLED",
      } as const;
      expect(await moveTicketToLane(actor, before.id, lanes[from])).toEqual(before);
      expect(await db.ticket.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      expect(await audits(before.id)).toEqual(logs);
    });
  }
});
