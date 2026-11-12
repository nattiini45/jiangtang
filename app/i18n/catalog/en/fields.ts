import type { fieldsDe } from "../de/fields";
export const fieldsEn = {
  "fields.admin.saved": "Field saved.",
  "fields.admin.labelInvalid": "Enter between 1 and 80 characters.",
  "fields.admin.everyKindHint":
    "Only fields for every kind are shown here. Choose a device kind to see its own fields too.",
  "fields.admin.moveUp": "Move {name} up",
  "fields.admin.moveDown": "Move {name} down",
  "fields.admin.sectionMoveUp": "Move section {name} up",
  "fields.admin.sectionMoveDown": "Move section {name} down",
  "fields.error.inUseOne":
    "{count} record still holds a value for this field. Restore it and make it apply to the record before clearing its value, or keep it archived.",
  "fields.error.ambiguousNumber":
    "This number is ambiguous. Use {thousands} for thousands or {decimal} for a decimal.",
  "fields.type.TEXT": "Text",
  "fields.type.LONG_TEXT": "Long text",
  "fields.type.NUMBER": "Number",
  "fields.type.BOOLEAN": "Yes / no",
  "fields.type.CHOICE": "Single choice",
  "fields.type.MULTI_CHOICE": "Multiple choice",
  "fields.type.DATE": "Date",
  "fields.type.LINK": "Link",
  "fields.admin.scope": "Fields for",
  "fields.admin.rooms": "Rooms",
  "fields.admin.devices": "Devices",
  "fields.admin.viewKind": "Device kind",
  "fields.admin.add": "Add field",
  "fields.admin.addFirst": "Add the first field",
  "fields.admin.empty": "No fields here yet",
  "fields.admin.emptyHelp": "Add the details your team needs on its forms.",
  "fields.admin.edit": "Edit field",
  "fields.admin.type": "Type",
  "fields.admin.applies": "Applies to",
  "fields.admin.chosenKinds": "Chosen device kinds",
  "fields.admin.chooseOne": "Choose at least one device kind.",
  "fields.admin.moreSettings": "More settings",
  "fields.admin.section": "Section",
  "fields.admin.unit": "Unit",
  "fields.admin.help": "Help text",
  "fields.admin.key": "Key for agents (read-only)",
  "fields.admin.typeLocked":
    "This type cannot be changed. Create another field for a different type.",
  "fields.admin.convertText":
    "Existing text stays unchanged. The field will allow up to 4,000 characters.",
  "fields.admin.convertMulti":
    "Each saved selection becomes a list with one option. The options and their IDs stay unchanged.",
  "fields.admin.convertSingle":
    "This works only if every record has at most one selected option. Lists with one option become a single selection.",
  "fields.admin.sectionUp": "Move section up",
  "fields.admin.sectionDown": "Move section down",
  "fields.admin.restoreOffer":
    "The archived field “{name}” already has this name. Restore it to keep its existing values.",
  "fields.admin.restoreExisting": "Restore this field",
  "fields.admin.reuseOffer":
    "The field “{name}” already exists for other device kinds as {type}. Reuse that field and its type for these kinds too, or save a separate field.",
  "fields.admin.reuse": "Use this field here too",
  "fields.admin.openHolder": "Open the existing field",
  "fields.admin.archiveFirst": "Archive this field before deleting it.",
  "fields.admin.deleteConfirm":
    "Delete the archived field “{name}” and its options? This cannot be undone.",
  "fields.admin.options": "Options",
  "fields.admin.optionLabel": "Option label",
  "fields.admin.newOption": "New option",
  "fields.admin.addOption": "Add option",
  "fields.admin.deleteOptionConfirm": "Delete the unused option “{name}”? This cannot be undone.",
  "fields.admin.optionTaken":
    "An active option already has this label. Rename it or archive it first.",
  "fields.admin.paste": "Paste several",
  "fields.admin.pasteHelp": "One option per line",
  "fields.admin.preview": "Preview",
  "fields.admin.paste.new": "New",
  "fields.admin.paste.repeat": "Repeated · skipped",
  "fields.admin.paste.limit": "Over the limit · skipped",
  "fields.admin.paste.invalid": "Too long · skipped",
  "fields.admin.confirmPaste": "Add {count} options",
  "fields.name.conflict":
    "The {state} field “{name}” already uses this name for {coverage}. Choose another name or edit that field first.",
  "fields.name.active": "active",
  "fields.name.archived": "archived",
  "fields.name.allRooms": "every room",
  "fields.name.allKinds": "every device kind",
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
    "{count} records still hold a value for this field. Restore it and make it apply to the affected records before clearing their values, or keep it archived.",
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
