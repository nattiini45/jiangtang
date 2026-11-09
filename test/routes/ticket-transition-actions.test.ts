import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { ticketAllowedActions } from "~/domains/tickets/tickets.transitions";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => ({
    id: null,
    name: "Synthetic transition route member",
    role: "MEMBER",
  })),
}));

const desktop = await import("~/routes/_desktop.tickets.$id/route");
const mobile = await import("~/routes/m.tickets.$id/route");
const board = await import("~/routes/_desktop.board/route");
const ids: string[] = [];
const actor = { id: null, name: "Synthetic transition route member" };

async function make(status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CANCELLED" = "OPEN") {
  const ticket = await createTicket(actor, {
    title: "Synthetic route ticket",
    type: "INCIDENT",
    status,
    resolution: "Synthetic original",
    assigneeIds: [],
  });
  ids.push(ticket.id);
  return ticket;
}
const request = (path: string, fields: Record<string, string>) =>
  new Request(`http://localhost${path}`, { method: "POST", body: new URLSearchParams(fields) });

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("ticket route action metadata", () => {
  it("normalizes board resolution input through the shared transition schema", async () => {
    const ticket = await make();
    const result = await board.action({
      request: request("/board", {
        _action: "move-ticket",
        ticketId: ticket.id,
        lane: "DONE",
        resolution: "  Synthetic repair completed  ",
      }),
    } as never);
    expect(result).toEqual({ ok: true });
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      status: "RESOLVED",
      resolution: "Synthetic repair completed",
    });
  });

  for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"] as const) {
    it(`${status}: desktop/mobile loaders and board cards expose the table projection`, async () => {
      const ticket = await make(status);
      for (const route of [desktop, mobile]) {
        const detail = await route.loader({
          request: new Request(`http://localhost/tickets/${ticket.id}`),
          params: { id: ticket.id },
        } as never);
        expect(detail.allowedActions).toEqual(ticketAllowedActions(status));
      }
      const loaded = await board.loader({
        request: new Request("http://localhost/board?mode=work"),
      } as never);
      const card = Object.values(loaded.ticketLanes)
        .flat()
        .find((card) => card.id === ticket.id);
      expect(card?.allowedActions).toEqual(ticketAllowedActions(status));
    });
  }

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: every action retains structured missing-resolution errors without writing or auditing`, async () => {
      const ticket = await make();
      const count = await db.activityLog.count({
        where: { entityType: "ticket", entityId: ticket.id },
      });
      await runWithLocale(locale, async () => {
        for (const route of [desktop, mobile]) {
          const result = await route.action({
            request: request(`/tickets/${ticket.id}`, {
              _action: "transition",
              status: "RESOLVED",
              resolution: "   ",
            }),
            params: { id: ticket.id },
          } as never);
          expect(result).toMatchObject({
            fieldErrors: { resolution: [t(locale, "work.err.ticket.resolutionRequired")] },
            formError: t(locale, "work.err.ticket.resolutionRequired"),
            transition: {
              currentState: "OPEN",
              attemptedTarget: "RESOLVED",
              reason: { code: "RESOLUTION_REQUIRED" },
            },
          });
        }
        const result = await board.action({
          request: request("/board", { _action: "move-ticket", ticketId: ticket.id, lane: "DONE" }),
        } as never);
        expect(result).toMatchObject({
          fieldErrors: { resolution: [t(locale, "work.err.ticket.resolutionRequired")] },
          formErrors: [t(locale, "work.err.ticket.resolutionRequired")],
          transition: {
            entity: "ticket",
            currentState: "OPEN",
            attemptedTarget: "RESOLVED",
            allowedTransitions: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
            reason: { code: "RESOLUTION_REQUIRED" },
          },
        });
        const illegal = await board.action({
          request: request("/board", {
            _action: "move-ticket",
            ticketId: ticket.id,
            lane: "IN_REVIEW",
          }),
        } as never);
        expect(illegal).toMatchObject({
          transition: {
            currentState: "OPEN",
            attemptedTarget: "IN_REVIEW",
            allowedActions: ticketAllowedActions("OPEN"),
            reason: { code: "UNSUPPORTED_LANE" },
          },
        });
      });
      expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
      expect(
        await db.activityLog.count({ where: { entityType: "ticket", entityId: ticket.id } }),
      ).toBe(count);
    });
  }
});
