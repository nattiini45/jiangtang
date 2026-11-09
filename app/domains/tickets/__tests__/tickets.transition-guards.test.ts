import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { TransitionError, ValidationError, toErrorResponse } from "~/lib/errors.server";
import {
  createTicket,
  moveTicketToLane,
  transitionTicket,
} from "~/domains/tickets/tickets.mutations.server";

const actor = { id: null, name: "Synthetic transition guard test" };
const ids: string[] = [];
async function make() {
  const ticket = await createTicket(actor, {
    title: "Synthetic resolution guard",
    type: "INCIDENT",
    status: "OPEN",
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

describe("ticket transition guards", () => {
  for (const resolution of [undefined, "", " \n\t "]) {
    for (const via of ["direct", "board"] as const) {
      it(`${via} rejects ${JSON.stringify(resolution)} resolution without a write or audit`, async () => {
        const ticket = await make();
        const before = await audits(ticket.id);
        const error = await (
          via === "direct"
            ? transitionTicket(actor, ticket.id, { status: "RESOLVED", resolution })
            : moveTicketToLane(actor, ticket.id, "DONE", { resolution })
        ).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(TransitionError);
        const response = toErrorResponse(error);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          fieldErrors: { resolution: [expect.any(String)] },
          formErrors: [expect.any(String)],
          transition: {
            entity: "ticket",
            currentState: "OPEN",
            attemptedTarget: "RESOLVED",
            allowedTransitions: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
            reason: { code: "RESOLUTION_REQUIRED", message: expect.any(String) },
          },
        });
        expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
        expect(await audits(ticket.id)).toEqual(before);
      });
    }
  }

  it("rejects a board DONE move with the optional transition argument omitted", async () => {
    const ticket = await make();
    await expect(moveTicketToLane(actor, ticket.id, "DONE")).rejects.toBeInstanceOf(
      TransitionError,
    );
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
    expect(await audits(ticket.id)).toHaveLength(1);
  });

  it("serializes two resolves blocked behind a real row lock", async () => {
    const ticket = await make();
    let locked!: () => void;
    let release!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = txWithAudit(actor, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" = ${ticket.id} FOR UPDATE`;
      locked();
      await unlock;
    });
    await lockReady;
    const competing = Promise.allSettled([
      transitionTicket(actor, ticket.id, { status: "RESOLVED", resolution: "First repair" }),
      transitionTicket(actor, ticket.id, { status: "RESOLVED", resolution: "Second repair" }),
    ]);
    try {
      await expect
        .poll(
          async () => {
            const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query LIKE '%"Ticket"%'
        `;
            return Number(row.count);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await blocker;
    }
    const results = await competing;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(TransitionError);
    expect(rejected?.reason.transition).toMatchObject({
      currentState: "RESOLVED",
      attemptedTarget: "RESOLVED",
      reason: { code: "INVALID_TRANSITION" },
    });
    const logs = await audits(ticket.id);
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log.action === "TicketResolved")?.data).toEqual({
      from: "OPEN",
      to: "RESOLVED",
    });
  });
});
