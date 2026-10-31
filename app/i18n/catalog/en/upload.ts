import type { uploadDe } from "../de/upload";

export const uploadEn = {
  "upload.category.ROOM": "Room",
  "upload.category.CONTROL_PANEL": "Control panel",
  "upload.category.CONNECTION_PANEL": "Connection panel",
  "upload.category.EQUIPMENT": "Equipment",
  "upload.category.TICKET": "Ticket",
  "upload.submit": "Upload",
  "upload.busy": "Uploading…",
  "upload.gallery.empty": "No photos yet.",
  "upload.gallery.delete": "Delete photo",
  "upload.gallery.confirmDelete": "Delete this photo?",
} satisfies Record<keyof typeof uploadDe, string>;
