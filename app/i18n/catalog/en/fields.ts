import type { fieldsDe } from "../de/fields";
export const fieldsEn = {
  "fields.limit.fields":
    "At most 40 active fields can apply to a record. Archive a field or restrict it to other device kinds.",
  "fields.limit.total": "At most 120 fields per scope. Delete an unused field.",
  "fields.limit.options": "At most 50 active options per field. Retire or delete an option.",
  "fields.limit.totalOptions": "At most 200 options per field. Delete an unused option.",
  "fields.error.roomKinds": "Room fields apply to every room. Remove the device kinds.",
  "fields.error.kind":
    "A device kind is missing, archived or duplicated. Select active device kinds.",
  "fields.error.unit": "Only number fields have a unit. Remove the unit.",
  "fields.error.choice": "Only choice fields have options. Use a choice field.",
} satisfies Record<keyof typeof fieldsDe, string>;
