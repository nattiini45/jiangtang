import { BookingConflictError, isExclusionViolation } from "~/lib/errors.server";

/**
 * The booking helper. The no-double-booking invariant is enforced by the
 * database (GiST EXCLUDE on EventRoomBooking / EquipmentAllocation). Wrap any
 * insert/update of a bookable atom in `insertOrConflict` so a raw 23P01 surfaces
 * as a typed `BookingConflictError` (→ 409). Pre-checks in the UI are an
 * accelerator; THIS is the authority.
 */
export async function insertOrConflict<T>(run: () => Promise<T>, message?: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new BookingConflictError(message);
    }
    throw error;
  }
}

export { BookingConflictError, isExclusionViolation };
