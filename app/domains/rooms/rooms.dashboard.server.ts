import { db } from "~/lib/db.server";
import {
  listAttachments,
  type AttachmentRow,
} from "~/domains/attachments/attachments.queries.server";
import {
  ENTITY_TYPE,
  listEntityHistory,
  type ActivityEntry,
} from "~/domains/tickets/tickets.history.server";
import type {
  EquipmentCategory,
  EquipmentStatus,
  RoomStatus,
  TicketStatus,
  TicketType,
} from "~/generated/prisma/client";

/**
 * Per-room dashboard data: the room with its campus, building and equipment,
 * plus the room's tickets, attachments and activity history.
 *
 * Tickets are read with `db.ticket` directly instead of through
 * `tickets.queries.server.ts`: the dashboard needs exactly `TicketSummary` and a
 * hard 50-row cap, and `listTickets()` offers neither (it returns a richer row
 * shape with no limit). This is a read-only projection — ticket writes stay in
 * the tickets domain's audited mutations.
 */

export interface TicketSummary {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  occurredAt: Date;
  resolvedAt: Date | null;
}

export interface DashboardEquipment {
  id: string;
  name: string | null;
  category: EquipmentCategory;
  status: EquipmentStatus;
  assetTag: string | null;
  modelName: string | null;
}

export interface DashboardRoom {
  id: string;
  slug: string;
  name: string;
  roomNumber: string | null;
  status: RoomStatus;
  capacity: number | null;
  owner: string | null;
  campus: { name: string } | null;
  building: { name: string } | null;
  hasProjector: boolean;
  hasMicrophony: boolean;
  hasBlackboard: boolean;
  hasWebConference: boolean;
  hasAutoRecording: boolean;
  mediaKeyRequired: boolean;
  videoInputs: string[];
  audioOutputs: string[];
  bookingUrl: string | null;
  manualUrl: string | null;
  virtualTourUrl: string | null;
  tipsNotes: string | null;
  renewalStatus: string | null;
  lastCheckedAt: Date | null;
}

export interface RoomDashboardData {
  room: DashboardRoom;
  equipment: DashboardEquipment[];
  openTickets: TicketSummary[];
  recentTickets: TicketSummary[];
  attachments: AttachmentRow[];
  history: ActivityEntry[];
}

export async function getRoomDashboard(slug: string): Promise<RoomDashboardData | null> {
  const room = await db.room.findUnique({
    where: { slug },
    include: {
      campus: { select: { name: true } },
      building: { select: { name: true } },
      equipment: {
        orderBy: [{ category: "asc" }, { name: "asc" }],
        include: { model: { select: { name: true } } },
      },
    },
  });
  if (!room) return null;

  const tickets = await db.ticket.findMany({
    where: { roomId: room.id },
    orderBy: { occurredAt: "desc" },
    take: 50,
    select: { id: true, type: true, status: true, title: true, occurredAt: true, resolvedAt: true },
  });

  const attachments = await listAttachments({ roomId: room.id });
  const history = await listEntityHistory(ENTITY_TYPE.room, room.id, 20);

  const equipment: DashboardEquipment[] = room.equipment.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    status: e.status,
    assetTag: e.assetTag,
    modelName: e.model?.name ?? null,
  }));

  const dashboardRoom: DashboardRoom = {
    id: room.id,
    slug: room.slug,
    name: room.name,
    roomNumber: room.roomNumber,
    status: room.status,
    capacity: room.capacity,
    owner: room.owner,
    campus: room.campus,
    building: room.building,
    hasProjector: room.hasProjector,
    hasMicrophony: room.hasMicrophony,
    hasBlackboard: room.hasBlackboard,
    hasWebConference: room.hasWebConference,
    hasAutoRecording: room.hasAutoRecording,
    mediaKeyRequired: room.mediaKeyRequired,
    videoInputs: room.videoInputs,
    audioOutputs: room.audioOutputs,
    bookingUrl: room.bookingUrl,
    manualUrl: room.manualUrl,
    virtualTourUrl: room.virtualTourUrl,
    tipsNotes: room.tipsNotes,
    renewalStatus: room.renewalStatus,
    lastCheckedAt: room.lastCheckedAt,
  };

  return {
    room: dashboardRoom,
    equipment,
    openTickets: tickets.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS"),
    recentTickets: tickets.slice(0, 8),
    attachments,
    history,
  };
}
