import { db } from "~/lib/db.server";
import { Prisma, type TicketStatus, type TicketType } from "~/generated/prisma/client";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { listEquipment } from "~/domains/inventory/inventory.queries.server";
import { ticketActionMetadata } from "./tickets.transitions";

/** Read-only queries for the tickets domain (list, detail, assignable users). */

export interface TicketListRow {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  priority: number | null;
  roomName: string | null;
  roomSlug: string | null;
  equipmentName: string | null;
  assignees: string[]; // initials (or names where no initials)
  occurredAt: Date;
  resolvedAt: Date | null;
}

export function myOpenTicketWorkWhere(userId: string): Prisma.TicketWhereInput {
  return {
    status: { in: ["OPEN", "IN_PROGRESS"] },
    assignees: { some: { id: userId } },
    NOT: {
      task: { is: { status: { notIn: ["DONE", "CANCELLED"] }, assignees: { some: { userId } } } },
    },
  };
}

export async function listTickets(
  opts?: {
    type?: TicketType;
    status?: TicketStatus;
    roomId?: string;
    equipmentId?: string;
    assigneeId?: string;
    openWorkForUser?: string;
    q?: string;
  },
  page: { offset?: number; limit?: number } = {},
): Promise<TicketListRow[]> {
  const tickets = await db.ticket.findMany({
    skip: page.offset,
    take: page.limit,
    where: {
      ...(opts?.openWorkForUser ? myOpenTicketWorkWhere(opts.openWorkForUser) : {}),
      type: opts?.type,
      ...(opts?.status ? { status: opts.status } : {}),
      roomId: opts?.roomId,
      equipmentId: opts?.equipmentId,
      ...(opts?.assigneeId ? { assignees: { some: { id: opts.assigneeId } } } : {}),
      ...(opts?.q
        ? {
            OR: [
              { title: { contains: opts.q, mode: "insensitive" } },
              { description: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
    include: {
      room: { select: { name: true, slug: true } },
      equipment: { select: { name: true, assetTag: true } },
      assignees: { select: { initials: true, name: true } },
    },
  });
  return tickets.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    title: t.title,
    priority: t.priority,
    roomName: t.room?.name ?? null,
    roomSlug: t.room?.slug ?? null,
    equipmentName: t.equipment?.name ?? t.equipment?.assetTag ?? null,
    assignees: t.assignees.map((a) => a.initials ?? a.name),
    occurredAt: t.occurredAt,
    resolvedAt: t.resolvedAt,
  }));
}

/** Full ticket + linked entities for the detail / edit page. */
export async function getTicket(id: string) {
  const ticket = await db.ticket.findUnique({
    where: { id },
    include: {
      room: { select: { id: true, slug: true, name: true } },
      equipment: { select: { id: true, name: true, assetTag: true } },
      event: { select: { id: true, title: true } },
      reporter: { select: { id: true, name: true, initials: true } },
      assignees: { select: { id: true, name: true, initials: true } },
      // The harmony links: `task` is the PRIMARY task (`Ticket.taskId`),
      // `linkedTasks` every task whose `ticketId` points here (which usually
      // includes the primary task — the page filters the duplicate out).
      task: { select: { id: true, title: true, status: true } },
      linkedTasks: { select: { id: true, title: true, status: true } },
    },
  });
  return ticket ? { ...ticket, ...ticketActionMetadata(ticket.status) } : null;
}

export interface AssignableUser {
  id: string;
  name: string;
  initials: string | null;
}

/** Active accounts offered as reporter / assignees. */
export async function listAssignableUsers(
  page: { offset?: number; limit?: number } = {},
): Promise<AssignableUser[]> {
  const users = await db.user.findMany({
    skip: page.offset,
    take: page.limit,
    where: { isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, initials: true },
  });
  return users;
}

export interface TicketTargets {
  rooms: { id: string; name: string }[];
  equipment: { id: string; label: string }[];
  users: AssignableUser[];
}

/**
 * Picker data for the ticket forms: rooms, non-retired equipment (labelled with
 * tag + room), and assignable users. Composes the rooms/inventory query modules
 * read-only — the sanctioned cross-domain reuse (no schema or write coupling).
 */
export async function listTicketTargets(): Promise<TicketTargets> {
  const [rooms, equipment, users] = await Promise.all([
    listRooms(),
    listEquipment(),
    listAssignableUsers(),
  ]);
  return {
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.roomNumber ? `${r.name} (${r.roomNumber})` : r.name,
    })),
    equipment: equipment
      .filter((e) => e.status !== "RETIRED")
      .map((e) => ({
        id: e.id,
        label: [
          e.name ?? e.modelName ?? e.category,
          e.assetTag,
          e.roomName ? `(${e.roomName})` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    users,
  };
}

/**
 * Dashboard „Meine Arbeit": tickets assigned to the user that are still
 * open (OPEN or IN_PROGRESS — the other two statuses are settled).
 */
export async function listMyTickets(userId: string, limit = 5) {
  const where: Prisma.TicketWhereInput = {
    status: { in: ["OPEN", "IN_PROGRESS"] },
    assignees: { some: { id: userId } },
  };
  const [tickets, ticketCount] = await Promise.all([
    db.ticket.findMany({
      where,
      select: { id: true, type: true, status: true, title: true, priority: true },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: limit,
    }),
    db.ticket.count({ where }),
  ]);
  return { tickets, ticketCount };
}
