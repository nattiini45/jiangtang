import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import type { TicketCreateInput } from "~/domains/tickets/tickets.schema";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for the mobile ticket routes:
 *  - the list loader ignores a garbage ?status (validated against the enum);
 *  - the detail action performs a legal transition through the domain (asserted
 *    against DB state) and rejects an illegal one.
 * requireUser is mocked to a fixed test actor; emitChange runs against the dev DB
 * (pg_notify with no listener is a harmless no-op). Cleanup deletes only our rows;
 * ActivityLog is append-only (never touched).
 */

const RUN = `m_tickets_${Date.now()}`;
const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Mobile Tester",
  email: `${RUN}@test.local`,
  initials: "MT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

// The route modules call requireUser(request); return our fixed actor. Other
// exports (getOptionalUser, requireRole, sanitizeNext, AuthUser type) are kept.
vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Import AFTER the mock is registered so the routes see the mocked requireUser.
const indexRoute = await import("~/routes/m.tickets._index/route");
const detailRoute = await import("~/routes/m.tickets.$id/route");

const createdTicketIds: string[] = [];

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: createdTicketIds } } });
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

const actor = { id: null as string | null, name: "Mobile Tester", initials: "MT" };

async function seedTicket(over: Partial<TicketCreateInput> & { title: string }) {
  const t = await createTicket(actor, input(over));
  createdTicketIds.push(t.id);
  return t;
}

function req(url: string, body?: Record<string, string>): Request {
  if (!body) return new Request(url);
  const form = new URLSearchParams(body);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("m.tickets index loader", () => {
  it("ignores a garbage ?status param (validated against the enum)", async () => {
    await seedTicket({ title: `${RUN} idx` });
    const res = await indexRoute.loader({
      request: req("http://localhost/m/tickets?status=NONSENSE"),
    } as never);
    // Invalid status is dropped → the loader reports an empty filter, not a throw.
    expect(res.status).toBe("");
    expect(Array.isArray(res.tickets)).toBe(true);
  });

  it("keeps a valid ?status param", async () => {
    const res = await indexRoute.loader({
      request: req("http://localhost/m/tickets?status=RESOLVED"),
    } as never);
    expect(res.status).toBe("RESOLVED");
    // Every returned row actually matches the requested status.
    expect(res.tickets.every((t) => t.status === "RESOLVED")).toBe(true);
  });
});

describe("m.tickets detail action", () => {
  it("performs a legal transition through the domain (OPEN → IN_PROGRESS)", async () => {
    const t = await seedTicket({ title: `${RUN} start` });

    const res = await detailRoute.action({
      request: req(`http://localhost/m/tickets/${t.id}`, { status: "IN_PROGRESS" }),
      params: { id: t.id },
    } as never);

    // Success returns a redirect back to the detail page.
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("location")).toBe(`/m/tickets/${t.id}`);

    const after = await db.ticket.findUnique({ where: { id: t.id } });
    expect(after?.status).toBe("IN_PROGRESS");
  });

  it("resolves with a resolution note and stamps resolvedAt", async () => {
    const t = await seedTicket({ title: `${RUN} resolve` });

    await detailRoute.action({
      request: req(`http://localhost/m/tickets/${t.id}`, {
        status: "RESOLVED",
        resolution: "Beamer neu gestartet.",
      }),
      params: { id: t.id },
    } as never);

    const after = await db.ticket.findUnique({ where: { id: t.id } });
    expect(after?.status).toBe("RESOLVED");
    expect(after?.resolution).toBe("Beamer neu gestartet.");
    expect(after?.resolvedAt).not.toBeNull();
  });

  it("rejects an illegal transition and leaves the ticket unchanged", async () => {
    // Born-resolved; RESOLVED → CANCELLED is not a permitted move.
    const t = await seedTicket({
      title: `${RUN} illegal`,
      status: "RESOLVED",
      resolution: "fertig",
    });

    const res = await detailRoute.action({
      request: req(`http://localhost/m/tickets/${t.id}`, { status: "CANCELLED" }),
      params: { id: t.id },
    } as never);

    // The action catches the ValidationError and returns a visible form error
    // (not a redirect, not a throw).
    expect(res).not.toBeInstanceOf(Response);
    const data = res as { formError?: string; fieldErrors?: Record<string, string[]> };
    expect(data.formError).toMatch(/Ungültiger Statuswechsel/);
    expect(data.fieldErrors?.status?.[0]).toMatch(/Ungültiger Statuswechsel/);

    const after = await db.ticket.findUnique({ where: { id: t.id } });
    expect(after?.status).toBe("RESOLVED");
  });
});
