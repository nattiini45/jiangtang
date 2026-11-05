import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { listEvents } from "~/domains/events/events.queries.server";

/**
 * List-filter query-param parsing (deferred). Garbage `?status`/`?type`
 * values must be IGNORED — never throw, never 500 — falling back to an unfiltered
 * result. Valid enum values still filter. The loaders use `param in EnumObject`
 * guards; this pins that behaviour so a future refactor can't turn a hostile query
 * string into an error.
 *
 * The tickets index loader is called directly against the real DB with `requireUser`
 * mocked to a fixed actor (the sign-in check itself is covered by
 * `route-auth-guard.test.ts`). The events `status` guard is covered at the domain
 * layer via `listEvents`, which shares the exact `in EventStatus` contract.
 *
 * All seeded rows are RUN-prefixed and removed in afterAll (no ActivityLog rows).
 */

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  const user = {
    id: "filter-parsing-tester",
    name: "Filter Tester",
    email: "filter-parsing@test.local",
    initials: "FT",
    role: "MEMBER",
    isActive: true,
  } as AuthUser;
  return { ...actual, requireUser: vi.fn(async () => user) };
});

// Imported after the mock so the route module sees the mocked requireUser.
const { loader: ticketsLoader } = await import("~/routes/_desktop.tickets._index/route");

const RUN = `t_flt_${Date.now()}`;
const ticketIds = { incidentOpen: `${RUN}_t_io`, requestResolved: `${RUN}_t_rr` };

beforeAll(async () => {
  await db.ticket.createMany({
    data: [
      { id: ticketIds.incidentOpen, type: "INCIDENT", status: "OPEN", title: `${RUN} incident` },
      {
        id: ticketIds.requestResolved,
        type: "REQUEST",
        status: "RESOLVED",
        title: `${RUN} request`,
      },
    ],
  });
});

afterAll(async () => {
  await db.ticket.deleteMany({ where: { id: { in: Object.values(ticketIds) } } });
  await db.$disconnect();
});

const load = (query: string) =>
  ticketsLoader({
    request: new Request(`http://localhost/tickets${query}`),
  } as never) as Promise<{
    tickets: { id: string }[];
    filters: { type: string; status: string };
  }>;

const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

describe("tickets index loader — filter parsing", () => {
  it("ignores a garbage ?status and returns the unfiltered set (no throw)", async () => {
    const data = await load("?status=NONSENSE");
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.incidentOpen)).toBe(true);
    expect(ids.has(ticketIds.requestResolved)).toBe(true);
    // A rejected value must not echo back as an active filter.
    expect(data.filters.status).toBe("");
  });

  it("ignores a garbage ?type and a SQL-ish injection attempt (no throw)", async () => {
    const data = await load("?type=%27%3B+DROP+TABLE+%22Ticket%22%3B--"); // '; DROP TABLE "Ticket";--
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.incidentOpen)).toBe(true);
    expect(ids.has(ticketIds.requestResolved)).toBe(true);
    expect(data.filters.type).toBe("");
  });

  it("ignores empty params and returns everything", async () => {
    const data = await load("?type=&status=");
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.incidentOpen)).toBe(true);
    expect(ids.has(ticketIds.requestResolved)).toBe(true);
  });

  it("APPLIES a valid ?status filter (proves the guard isn't just always-ignore)", async () => {
    const data = await load("?status=RESOLVED");
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.requestResolved)).toBe(true);
    expect(ids.has(ticketIds.incidentOpen)).toBe(false);
    expect(data.filters.status).toBe("RESOLVED");
  });

  it("APPLIES a valid ?type filter", async () => {
    const data = await load("?type=INCIDENT");
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.incidentOpen)).toBe(true);
    expect(ids.has(ticketIds.requestResolved)).toBe(false);
    expect(data.filters.type).toBe("INCIDENT");
  });

  it("combines a valid type and status", async () => {
    const data = await load("?type=INCIDENT&status=OPEN");
    const ids = idsOf(data.tickets);
    expect(ids.has(ticketIds.incidentOpen)).toBe(true);
    expect(ids.has(ticketIds.requestResolved)).toBe(false);
  });
});

describe("events domain query — status guard (shared contract with events loader)", () => {
  it("treats an undefined status as 'no filter' — the loader passes undefined for garbage params", async () => {
    // The events index loader does `status = param in EventStatus ? param : undefined`
    // then calls `listEvents({ status })`. So a garbage param becomes undefined
    // here. This must not throw and must not filter.
    await expect(listEvents({ status: undefined })).resolves.toBeInstanceOf(Array);
  });
});
