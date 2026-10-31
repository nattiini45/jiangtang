import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { createTicket, transitionTicket } from "~/domains/tickets/tickets.mutations.server";
import { ENTITY_TYPE, listEntityHistory } from "~/domains/tickets/tickets.history.server";
import type { TicketCreateInput } from "~/domains/tickets/tickets.schema";

/**
 * Per-entity history: listEntityHistory returns this entity's append-only
 * ActivityLog rows, newest-first, scoped to the given (entityType, entityId).
 */

const RUN = `tickethist_${Date.now()}`;
const actor = { id: null as string | null, name: "History Tester", initials: "HT" };
const createdTicketIds: string[] = [];
const createdRoomIds: string[] = [];

afterAll(async () => {
  // ActivityLog is append-only (no delete) — rows we insert directly below are
  // left in place, same as other tests that write ActivityLog rows directly.
  await db.ticket.deleteMany({ where: { id: { in: createdTicketIds } } });
  await db.room.deleteMany({ where: { id: { in: createdRoomIds } } });
  await db.$disconnect();
});

function input(title: string): TicketCreateInput {
  return {
    type: "INCIDENT",
    title,
    description: undefined,
    priority: undefined,
    roomId: undefined,
    equipmentId: undefined,
    eventId: undefined,
    reporterId: undefined,
    assigneeIds: [],
    occurredAt: undefined,
    status: "OPEN",
    resolution: undefined,
    resolvedAt: undefined,
  };
}

describe("ticket history", () => {
  it("returns this ticket's activity newest-first", async () => {
    const t = await createTicket(actor, input(`${RUN} hist`));
    createdTicketIds.push(t.id);
    await transitionTicket(actor, t.id, { status: "IN_PROGRESS", resolution: undefined });
    await transitionTicket(actor, t.id, { status: "RESOLVED", resolution: "Erledigt." });

    const other = await createTicket(actor, input(`${RUN} other`));
    createdTicketIds.push(other.id);

    const history = await listEntityHistory("ticket", t.id);
    const actions = history.map((h) => h.action);

    expect(actions).toContain("TicketCreated");
    expect(actions).toContain("TicketStarted");
    expect(actions).toContain("TicketResolved");
    // newest-first: the resolve happened after the create.
    expect(actions.indexOf("TicketResolved")).toBeLessThan(actions.indexOf("TicketCreated"));
    // scoped to this entity only (the other ticket's rows are excluded).
    expect(history.every((h) => h.entityId === t.id)).toBe(true);
  });

  it("matches entityType exactly — locks in the lowercase casing contract", async () => {
    // All domain mutation writers persist ActivityLog.entityType in lowercase
    // (e.g. "room", not "Room" — see app/domains/rooms/rooms.mutations.server.ts).
    // listEntityHistory does an exact, case-sensitive match. Readers that pass
    // the wrong casing silently get zero rows back.
    const room = await db.room.create({
      data: { name: `${RUN} room`, slug: `${RUN}-room`, status: "ALL_GOOD" },
    });
    createdRoomIds.push(room.id);
    await db.activityLog.create({
      data: {
        action: "RoomCreated",
        entityType: ENTITY_TYPE.room,
        entityId: room.id,
        actorSnapshot: { initials: "HT", name: "History Tester" },
      },
    });

    const lowercase = await listEntityHistory(ENTITY_TYPE.room, room.id);
    expect(lowercase).toHaveLength(1);
    expect(lowercase[0].action).toBe("RoomCreated");

    const wrongCasing = await listEntityHistory("Room", room.id);
    expect(wrongCasing).toHaveLength(0);
  });
});
