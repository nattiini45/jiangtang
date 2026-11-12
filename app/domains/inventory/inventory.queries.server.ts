import { db } from "~/lib/db.server";
import type {
  EquipmentCategory,
  EquipmentMobility,
  EquipmentStatus,
} from "~/generated/prisma/client";

/** Read-only queries for typed Equipment instances. Decimal frequencyMhz is
 * stringified at the boundary so loader payloads stay JSON-serializable. */

export interface EquipmentListRow {
  id: string;
  name: string | null;
  category: EquipmentCategory;
  status: EquipmentStatus;
  mobility: EquipmentMobility;
  assetTag: string | null;
  roomName: string | null;
  roomSlug: string | null;
  modelName: string | null;
  ipAddress: string | null;
  frequencyMhz: string | null;
}

export async function listEquipment(
  opts?: {
    roomId?: string;
    modelId?: string;
    category?: EquipmentCategory;
    status?: EquipmentStatus;
    mobility?: EquipmentMobility;
    q?: string;
  },
  page: { offset?: number; limit?: number } = {},
): Promise<EquipmentListRow[]> {
  const items = await db.equipment.findMany({
    skip: page.offset,
    take: page.limit,
    where: {
      roomId: opts?.roomId,
      modelId: opts?.modelId,
      category: opts?.category,
      status: opts?.status,
      mobility: opts?.mobility,
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q, mode: "insensitive" } },
              { assetTag: { contains: opts.q, mode: "insensitive" } },
              { serial: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
    include: { room: { select: { name: true, slug: true } }, model: { select: { name: true } } },
  });
  return items.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    status: e.status,
    mobility: e.mobility,
    assetTag: e.assetTag,
    roomName: e.room?.name ?? null,
    roomSlug: e.room?.slug ?? null,
    modelName: e.model?.name ?? null,
    ipAddress: e.ipAddress,
    frequencyMhz: e.frequencyMhz ? e.frequencyMhz.toString() : null,
  }));
}

export function getEquipment(id: string) {
  return db.equipment.findUnique({
    where: { id },
    include: {
      ports: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      model: {
        select: { id: true, name: true, manufacturer: true, ports: { select: { label: true } } },
      },
      room: { select: { id: true, slug: true, name: true } },
      substitutingFor: { select: { id: true, name: true, assetTag: true } },
      substitutedBy: { select: { id: true, name: true, assetTag: true } },
    },
  });
}

/** Faulty fixed units that could be substituted by a spare (substitution picker). */
export async function listSubstitutionTargets(excludeId: string) {
  return db.equipment.findMany({
    where: {
      id: { not: excludeId },
      status: { in: ["FAULTY", "MAINTENANCE"] },
      substitutedBy: null,
    },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, assetTag: true, category: true },
  });
}
