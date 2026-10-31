import { db } from "~/lib/db.server";
import type { RoomStatus } from "~/generated/prisma/client";

/**
 * Read-only queries for the rooms domain. (Room detail / dashboard queries are
 * appended with their steps; this holds location lookups + the room list.)
 */

export interface CampusWithBuildings {
  id: string;
  name: string;
  slug: string;
  roomCount: number;
  buildings: { id: string; name: string; code: string | null; roomCount: number }[];
}

export async function listCampuses(): Promise<CampusWithBuildings[]> {
  const campuses = await db.campus.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { rooms: true } },
      buildings: {
        orderBy: { name: "asc" },
        include: { _count: { select: { rooms: true } } },
      },
    },
  });
  return campuses.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    roomCount: c._count.rooms,
    buildings: c.buildings.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      roomCount: b._count.rooms,
    })),
  }));
}

export function listBuildings(campusId?: string) {
  return db.building.findMany({
    where: campusId ? { campusId } : {},
    orderBy: { name: "asc" },
  });
}

export async function campusNameExists(name: string, excludeId?: string): Promise<boolean> {
  const found = await db.campus.findFirst({
    where: { name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  return found !== null;
}

export async function buildingNameExists(
  campusId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const found = await db.building.findFirst({
    where: { campusId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  return found !== null;
}

// ── Rooms ────────────────────────────────────────────────────────────────────

export interface RoomListRow {
  id: string;
  slug: string;
  name: string;
  roomNumber: string | null;
  campusName: string | null;
  buildingName: string | null;
  status: RoomStatus;
  capacity: number | null;
  equipmentCount: number;
}

export async function listRooms(opts?: {
  campusId?: string;
  status?: RoomStatus;
  q?: string;
}): Promise<RoomListRow[]> {
  const rooms = await db.room.findMany({
    where: {
      campusId: opts?.campusId,
      status: opts?.status,
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q, mode: "insensitive" } },
              { roomNumber: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }],
    include: {
      campus: { select: { name: true } },
      building: { select: { name: true } },
      _count: { select: { equipment: true } },
    },
  });
  return rooms.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    roomNumber: r.roomNumber,
    campusName: r.campus?.name ?? null,
    buildingName: r.building?.name ?? null,
    status: r.status,
    capacity: r.capacity,
    equipmentCount: r._count.equipment,
  }));
}

export async function roomSlugExists(slug: string): Promise<boolean> {
  const found = await db.room.findUnique({ where: { slug }, select: { id: true } });
  return found !== null;
}

/** Full room + its campus/building names (edit prefill, clone source, dashboard header). */
export function getRoomBySlug(slug: string) {
  return db.room.findUnique({
    where: { slug },
    include: {
      campus: { select: { id: true, name: true } },
      building: { select: { id: true, name: true } },
    },
  });
}
