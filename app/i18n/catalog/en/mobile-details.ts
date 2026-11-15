import type { mobileDetailsDe } from "../de/mobile-details";

export const mobileDetailsEn = {
  "mobileDetails.desktop": "Open desktop view",
  "mobileDetails.eventTime": "Event time",
  "mobileDetails.roomBack": "Back to rooms",
  "mobileDetails.noteBack": "Back to notes",
  "mobileDetails.schedule": "Bookings on the selected day",
  "mobileDetails.scheduleHint":
    "The booking schedule shows reservations, not whether the room is in use or operational.",
  "mobileDetails.noBookings": "No bookings on this day",
  "mobileDetails.roomStatus": "Room status",
  "mobileDetails.qr": "Room QR code",
  "mobileDetails.reportEquipment": "Capture an entry for {name}",
  "mobileDetails.noteEmpty": "This note has no text yet.",
} satisfies Record<keyof typeof mobileDetailsDe, string>;
