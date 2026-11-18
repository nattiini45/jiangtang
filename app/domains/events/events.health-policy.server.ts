import type { Tx } from "~/lib/db.server";
import { TransitionError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { RoomStatus } from "~/generated/prisma/client";
import { EquipmentMobility, EquipmentStatus } from "~/generated/prisma/enums";
import { NotFoundError } from "~/lib/errors.server";
import {
  HEALTH_OVERRIDE_FIELDS,
  roomBookingAction,
  equipmentAllocationAction,
  type HealthBookingAction,
} from "./events.health-policy";

export function bookingHealthOverride(
  entity: "room" | "equipment",
  currentState: string,
  action: HealthBookingAction,
  input: { healthOverrideConfirmed?: boolean; healthOverrideReason?: string },
) {
  if (!action.requiresConfirmation) return {};
  const reason = input.healthOverrideReason?.trim();
  if (input.healthOverrideConfirmed !== true || !reason) {
    const message = tr("events.health.overrideRequired");
    throw new TransitionError(
      {
        entity,
        currentState,
        attemptedTarget: action.target,
        allowedTransitions: [],
        allowedActions: [action],
        reason: { code: "HEALTH_OVERRIDE_REQUIRED", message },
      },
      Object.fromEntries(HEALTH_OVERRIDE_FIELDS.map((field) => [field, [message]])),
    );
  }
  return { healthOverride: { status: currentState, reason } };
}

export async function roomBookingHealthOverride(
  tx: Tx,
  roomId: string,
  input: { healthOverrideConfirmed?: boolean; healthOverrideReason?: string },
) {
  const [room] = await tx.$queryRaw<{ status: RoomStatus }[]>`
    SELECT "status" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE
  `;
  if (!room) throw new ValidationError({ roomId: [tr("err.room.notFound")] });
  return bookingHealthOverride("room", room.status, roomBookingAction(room.status), input);
}

export async function equipmentBookingHealthOverride(
  tx: Tx,
  input: { equipmentId: string; healthOverrideConfirmed?: boolean; healthOverrideReason?: string },
) {
  const [equipment] = await tx.$queryRaw<
    { mobility: EquipmentMobility; status: EquipmentStatus }[]
  >`SELECT "mobility", "status" FROM "Equipment" WHERE "id" = ${input.equipmentId} FOR UPDATE`;
  if (!equipment) throw new NotFoundError(tr("work.err.event.equipmentNotFound"));
  if (equipment.mobility !== EquipmentMobility.POOLED) {
    throw new ValidationError({ equipmentId: [tr("work.err.event.onlyPooled")] });
  }
  if (equipment.status === EquipmentStatus.RETIRED) {
    throw new ValidationError({ equipmentId: [tr("work.err.event.retiredEquipment")] });
  }
  return bookingHealthOverride(
    "equipment",
    equipment.status,
    equipmentAllocationAction(equipment.status, equipment.mobility),
    input,
  );
}
