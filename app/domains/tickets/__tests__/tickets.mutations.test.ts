import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  createTicket,
  transitionTicket,
  updateTicket,
} from "~/domains/tickets/tickets.mutations.server";
import { ValidationError } from "~/lib/errors.server";
import type { TicketCreateInput, TicketEditInput } from "~/domains/tickets/tickets.schema";

/**
 * Ticket mutation guards: open create + audit, born-resolved logbook entry
 * (resolution + back-dated resolvedAt + TicketResolved verb), the guarded status
 * workflow (start → resolve → reopen with the right resolvedAt), and assignee
 * replacement. Cleanup deletes tickets + the test users; ActivityLog is
 * append-only (never deleted).
 */

const RUN = `ticket_${Date.now()}`;
const actor = { id: null as string | null, name: "Ticket Tester", initials: "TT" };
const createdTicketIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: createdTicketIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

function input(over: Partial<TicketCreateInput> & { title: string }): TicketCreateInput {
  return {
    type: "INCIDENT",
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
    ...over,
  };
}

describe("ticket mutations", () => {
  it("creates an open ticket and writes a TicketCreated audit row", async () => {
    const t = await createTicket(actor, input({ title: `${RUN} open` }));
    createdTicketIds.push(t.id);

    expect(t.status).toBe("OPEN");
    expect(t.resolvedAt).toBeNull();

    const logs = await db.activityLog.findMany({
      where: { entityType: "ticket", entityId: t.id, action: "TicketCreated" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "TT" });
  });

  it("logs a born-resolved repair with resolution + back-dated resolvedAt", async () => {
    const occurred = new Date("2026-03-01T10:00:00.000Z");
    const t = await createTicket(
      actor,
      input({
        title: `${RUN} repair`,
        type: "REPAIR",
        status: "RESOLVED",
        resolution: "Defektes HDMI-Kabel getauscht.",
        occurredAt: occurred,
      }),
    );
    createdTicketIds.push(t.id);

    expect(t.status).toBe("RESOLVED");
    expect(t.resolution).toBe("Defektes HDMI-Kabel getauscht.");
    // resolvedAt defaults to the occurrence time when not given (truthful logbook).
    expect(t.resolvedAt?.toISOString()).toBe(occurred.toISOString());

    const logs = await db.activityLog.findMany({
      where: { entityType: "ticket", entityId: t.id, action: "TicketResolved" },
    });
    expect(logs).toHaveLength(1);
  });

  it("walks the status workflow with the correct resolvedAt + audit verbs", async () => {
    const t = await createTicket(actor, input({ title: `${RUN} flow` }));
    createdTicketIds.push(t.id);

    const started = await transitionTicket(actor, t.id, {
      status: "IN_PROGRESS",
      resolution: undefined,
    });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.resolvedAt).toBeNull();

    const resolved = await transitionTicket(actor, t.id, {
      status: "RESOLVED",
      resolution: "Beamer neu gestartet.",
    });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution).toBe("Beamer neu gestartet.");

    const reopened = await transitionTicket(actor, t.id, { status: "OPEN", resolution: undefined });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAt).toBeNull();
    // Reopening clears the resolved-state side-effects — no stale "solved" payload.
    expect(reopened.resolution).toBeNull();

    const verbs = (
      await db.activityLog.findMany({
        where: { entityType: "ticket", entityId: t.id },
        select: { action: true },
      })
    ).map((r) => r.action);
    expect(verbs).toContain("TicketStarted");
    expect(verbs).toContain("TicketResolved");
    expect(verbs).toContain("TicketReopened");
  });

  it("never stamps resolvedAt on a non-resolved create, even if a date is posted", async () => {
    const t = await createTicket(
      actor,
      input({
        title: `${RUN} inprog`,
        status: "IN_PROGRESS",
        resolvedAt: new Date("2026-05-01T00:00:00.000Z"),
      }),
    );
    createdTicketIds.push(t.id);
    expect(t.status).toBe("IN_PROGRESS");
    expect(t.resolvedAt).toBeNull();
  });

  it("rejects an illegal status transition and leaves the ticket unchanged", async () => {
    const t = await createTicket(
      actor,
      input({ title: `${RUN} illegal`, status: "RESOLVED", resolution: "fertig" }),
    );
    createdTicketIds.push(t.id);

    // RESOLVED → CANCELLED is not a permitted move.
    await expect(
      transitionTicket(actor, t.id, { status: "CANCELLED", resolution: undefined }),
    ).rejects.toBeTruthy();

    const still = await db.ticket.findUnique({ where: { id: t.id } });
    expect(still?.status).toBe("RESOLVED");
  });

  // The transition form renders no `status` field, so a field-only error
  // is invisible; the mutation must also populate formErrors (general/non-field)
  // so the route can render it as a visible message instead of a silent no-op.
  it("surfaces the illegal transition message as a general form error", async () => {
    const t = await createTicket(
      actor,
      input({ title: `${RUN} illegal-visible`, status: "RESOLVED", resolution: "fertig" }),
    );
    createdTicketIds.push(t.id);

    try {
      await transitionTicket(actor, t.id, { status: "CANCELLED", resolution: undefined });
      expect.unreachable("expected transitionTicket to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const err = e as ValidationError;
      expect(err.fieldErrors.status?.[0]).toMatch(/Ungültiger Statuswechsel/);
      expect(err.formErrors.length).toBeGreaterThan(0);
      expect(err.formErrors[0]).toMatch(/Ungültiger Statuswechsel/);
    }
  });

  it("replaces assignees wholesale on edit", async () => {
    const u1 = await db.user.create({ data: { email: `${RUN}-a@test.local`, name: "Assignee A" } });
    const u2 = await db.user.create({ data: { email: `${RUN}-b@test.local`, name: "Assignee B" } });
    createdUserIds.push(u1.id, u2.id);

    const t = await createTicket(actor, input({ title: `${RUN} assign`, assigneeIds: [u1.id] }));
    createdTicketIds.push(t.id);

    const before = await db.ticket.findUnique({
      where: { id: t.id },
      include: { assignees: true },
    });
    expect(before?.assignees.map((a) => a.id)).toEqual([u1.id]);

    const edit: TicketEditInput = {
      type: "INCIDENT",
      title: `${RUN} assign`,
      description: undefined,
      priority: undefined,
      roomId: undefined,
      equipmentId: undefined,
      eventId: undefined,
      reporterId: undefined,
      assigneeIds: [u2.id],
      occurredAt: undefined,
    };
    await updateTicket(actor, t.id, edit);

    const after = await db.ticket.findUnique({ where: { id: t.id }, include: { assignees: true } });
    expect(after?.assignees.map((a) => a.id)).toEqual([u2.id]);
  });

  // reporterId must only change when the edit input actually supplies it;
  // omitting the field (undefined) must not silently detach the reporter.
  it("preserves reporterId on edit when the field is omitted", async () => {
    const reporter = await db.user.create({
      data: { email: `${RUN}-reporter@test.local`, name: "Reporter" },
    });
    createdUserIds.push(reporter.id);

    const t = await createTicket(
      actor,
      input({ title: `${RUN} reporter-keep`, reporterId: reporter.id }),
    );
    createdTicketIds.push(t.id);
    expect(t.reporterId).toBe(reporter.id);

    const edit: TicketEditInput = {
      type: "INCIDENT",
      title: `${RUN} reporter-keep`,
      description: undefined,
      priority: undefined,
      roomId: undefined,
      equipmentId: undefined,
      eventId: undefined,
      reporterId: undefined, // omitted — must NOT clear the existing reporter
      assigneeIds: [],
      occurredAt: undefined,
    };
    const updated = await updateTicket(actor, t.id, edit);
    expect(updated.reporterId).toBe(reporter.id);
  });

  it("changes reporterId on edit when the field is explicitly supplied", async () => {
    const r1 = await db.user.create({
      data: { email: `${RUN}-r1@test.local`, name: "Reporter One" },
    });
    const r2 = await db.user.create({
      data: { email: `${RUN}-r2@test.local`, name: "Reporter Two" },
    });
    createdUserIds.push(r1.id, r2.id);

    const t = await createTicket(
      actor,
      input({ title: `${RUN} reporter-change`, reporterId: r1.id }),
    );
    createdTicketIds.push(t.id);

    const edit: TicketEditInput = {
      type: "INCIDENT",
      title: `${RUN} reporter-change`,
      description: undefined,
      priority: undefined,
      roomId: undefined,
      equipmentId: undefined,
      eventId: undefined,
      reporterId: r2.id,
      assigneeIds: [],
      occurredAt: undefined,
    };
    const updated = await updateTicket(actor, t.id, edit);
    expect(updated.reporterId).toBe(r2.id);
  });
});
