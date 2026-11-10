import type { EquipmentMobility, EquipmentStatus, RoomStatus } from "~/generated/prisma/client";
import type { TransitionAction } from "~/lib/transitions";

export const HEALTH_OVERRIDE_FIELDS = ["healthOverrideConfirmed", "healthOverrideReason"] as const;

export const ROOM_BOOKING_HEALTH = {
  ALL_GOOD: false,
  PROVISIONAL: false,
  MAINTENANCE_NEEDED: false,
  TECH_DEFECT: false,
  OUT_OF_SERVICE: true,
} as const satisfies Record<RoomStatus, boolean>;

export const EQUIPMENT_ALLOCATION_HEALTH = {
  OPERATIONAL: false,
  FAULTY: true,
  MAINTENANCE: true,
  RETIRED: false,
} as const satisfies Record<EquipmentStatus, boolean>;

export interface HealthBookingAction extends TransitionAction {
  requiresConfirmation: boolean;
}

export function roomBookingAction(status: RoomStatus): HealthBookingAction {
  const requiresConfirmation = ROOM_BOOKING_HEALTH[status];
  return {
    target: "BOOK",
    labelKey: "events.detail.bookRoom",
    requiredFields: requiresConfirmation ? HEALTH_OVERRIDE_FIELDS : [],
    allowed: true,
    requiresConfirmation,
  };
}

export function equipmentAllocationAction(
  status: EquipmentStatus,
  mobility: EquipmentMobility,
): HealthBookingAction {
  const allowed = mobility === "POOLED" && status !== "RETIRED";
  const requiresConfirmation = allowed && EQUIPMENT_ALLOCATION_HEALTH[status];
  return {
    target: "ALLOCATE",
    labelKey: "events.detail.allocateEquipment",
    requiredFields: requiresConfirmation ? HEALTH_OVERRIDE_FIELDS : [],
    allowed,
    requiresConfirmation,
  };
}

export function withRoomBookingAction<T extends { status: RoomStatus }>(room: T) {
  return { ...room, bookingAction: roomBookingAction(room.status) };
}

export function withEquipmentAllocationAction<
  T extends { status: EquipmentStatus; mobility: EquipmentMobility },
>(equipment: T) {
  return {
    ...equipment,
    allocationAction: equipmentAllocationAction(equipment.status, equipment.mobility),
  };
}

export function healthOverrideFromForm(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    healthOverrideConfirmed:
      input.healthOverrideConfirmed === "true"
        ? true
        : input.healthOverrideConfirmed === "false"
          ? false
          : input.healthOverrideConfirmed,
  };
}
