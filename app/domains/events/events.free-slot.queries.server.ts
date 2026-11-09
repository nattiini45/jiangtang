import { getRoom } from "~/domains/rooms/rooms.queries.server";
import { getEquipment } from "~/domains/inventory/inventory.queries.server";
import {
  findRoomConflicts,
  findEquipmentConflicts,
} from "~/domains/events/events.availability.server";
import { NotFoundError } from "~/lib/errors.server";

export async function findFreeSlot(options: {
  roomIds: string[];
  equipmentIds: string[];
  from: Date;
  to: Date;
  durationMinutes: number;
}) {
  const [rooms, equipment] = await Promise.all([
    Promise.all(options.roomIds.map((id) => getRoom(id))),
    Promise.all(options.equipmentIds.map((id) => getEquipment(id))),
  ]);
  if (rooms.some((room) => room === null) || equipment.some((item) => item === null)) {
    throw new NotFoundError();
  }
  const conflicts = (
    await Promise.all([
      ...options.roomIds.map((id) => findRoomConflicts(id, options.from, options.to)),
      ...options.equipmentIds.map((id) => findEquipmentConflicts(id, options.from, options.to)),
    ])
  )
    .flat()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const duration = options.durationMinutes * 60_000;
  let startsAt = options.from.getTime();
  for (const conflict of conflicts) {
    if (conflict.startsAt.getTime() >= startsAt + duration) break;
    startsAt = Math.max(startsAt, conflict.endsAt.getTime());
  }
  return {
    slot:
      startsAt + duration <= options.to.getTime()
        ? { startsAt: new Date(startsAt), endsAt: new Date(startsAt + duration) }
        : null,
    rooms: rooms.map((room) => ({ id: room!.id, name: room!.name, status: room!.status })),
    equipment: equipment.map((item) => ({
      id: item!.id,
      name: item!.name,
      assetTag: item!.assetTag,
      status: item!.status,
      mobility: item!.mobility,
    })),
  };
}
