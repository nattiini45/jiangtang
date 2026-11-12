import type { fieldsDe } from "../de/fields";
export const fieldsEn = {
  "fields.moreDetails": "More details",
  "fields.form.unset": "Not set",
  "fields.form.yes": "Yes",
  "fields.form.no": "No",
  "fields.form.clear": "Clear selection",
  "fields.form.search": "Search options for {name}",
  "fields.form.hidden":
    "{count} saved values stay hidden. They reappear when you choose the previous device kind.",
  "fields.form.archivedSelection":
    "This selection includes archived options. Changing it keeps only active options.",
  "fields.values.more": "Show {count} more details",
  "fields.values.less": "Show less",
  "fields.values.show": "Show details",
  "fields.values.hide": "Hide details",
  "fields.values.forDevice": "Details for {name}",
  "fields.values.openAll": "Expand all details",
  "fields.values.closeAll": "Collapse all details",
  "fields.values.newTab": "Opens in a new tab",
  "fields.error.encoding": "Remove invalid Unicode characters or NUL characters.",
  "fields.error.type":
    "Only text to long text and single choice to multiple choice (or back) are supported. Create a new field for another type.",
  "fields.error.multiple":
    "{count} records have multiple values. Reduce each selection to one value before changing the field type.",
  "fields.error.unknown": "This field does not exist. Fetch the current record schema.",
  "fields.error.archived": "This field is archived. Restore it first.",
  "fields.error.applicable":
    "This field does not apply to the device kind. Use the matching record schema.",
  "fields.error.number": "Enter a finite number with at most 6 decimal places.",
  "fields.error.value": "The value does not match the field type. Check the record schema.",
  "fields.error.option": "Choose active options from the allowed list, without duplicates.",
  "fields.error.inUse":
    "This field still has values. Restore it and make it apply to the affected records before clearing their values, or keep it archived.",
  "fields.error.optionInUse":
    "This option is still in use. Restore its field and make it apply to the affected records before clearing their values, or archive the option instead.",
  "fields.limit.text":
    "Text can contain at most 200 characters. Shorten it or use a long-text field.",
  "fields.limit.longText":
    "Long text can contain at most 4,000 characters. Shorten it or link a note instead.",
  "fields.limit.bytes":
    "Values can use at most 32 KB per record. Shorten, clear or replace values with a link.",
  "fields.option.retired": "{label} (archived)",
  "fields.limit.fields":
    "At most 40 active fields can apply to a record. Archive a field or restrict it to other device kinds.",
  "fields.limit.total": "At most 120 fields per scope. Delete an unused field.",
  "fields.limit.options": "At most 50 active options per field. Archive or delete an option.",
  "fields.limit.totalOptions": "At most 200 options per field. Delete an unused option.",
  "fields.error.roomKinds": "Room fields apply to every room. Remove the device kinds.",
  "fields.error.kind":
    "A device kind is missing, archived or duplicated. Select active device kinds.",
  "fields.error.unit": "Only number fields have a unit. Remove the unit.",
  "fields.error.choice": "Only choice fields have options. Use a choice field.",
} satisfies Record<keyof typeof fieldsDe, string>;
