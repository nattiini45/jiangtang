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

export async function listCampuses(
  page: { offset?: number; limit?: number } = {},
): Promise<CampusWithBuildings[]> {
  const campuses = await db.campus.findMany({
    skip: page.offset,
    take: page.limit,
    orderBy: [{ name: "asc" }, { id: "asc" }],
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

export function listBuildings(campusId?: string, page: { offset?: number; limit?: number } = {}) {
  return db.building.findMany({
    skip: page.offset,
    take: page.limit,
    where: campusId ? { campusId } : {},
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: { campus: { select: { id: true, name: true } } },
  });
}

export function getCampus(id: string) {
  return db.campus.findUnique({ where: { id } });
}

export function getBuilding(id: string) {
  return db.building.findUnique({
    where: { id },
    include: { campus: { select: { id: true, name: true } } },
  });
}

export function getRoom(id: string) {
  return db.room.findUnique({
    where: { id },
    include: {
      campus: { select: { id: true, name: true } },
      building: { select: { id: true, name: true } },
    },
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
  knownIssues: string | null;
  lastCheckedAt: Date | null;
}

export async function listRooms(
  opts?: {
    campusId?: string;
    status?: RoomStatus;
    q?: string;
  },
  page: { offset?: number; limit?: number } = {},
): Promise<RoomListRow[]> {
  const rooms = await db.room.findMany({
    skip: page.offset,
    take: page.limit,
    where: {
      campusId: opts?.campusId,
      status: opts?.status,
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q, mode: "insensitive" } },
              { roomNumber: { contains: opts.q, mode: "insensitive" } },
              { knownIssues: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
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
    knownIssues: r.knownIssues,
    lastCheckedAt: r.lastCheckedAt,
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
