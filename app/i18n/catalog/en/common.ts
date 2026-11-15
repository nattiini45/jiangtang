import type { commonDe } from "../de/common";

export const commonEn = {
  "common.unit.minutesShort": "min",
  "common.unit.hoursShort": "h",
  "notes.editor.savedAt": "Saved {time}",

  "common.error.title": "Error",
  "common.error.unexpected": "An unexpected error occurred.",
  "common.error.status": "Status {status}",
  "common.error.notFound.title": "Page not found",
  "common.error.notFound.detail": "The page you are looking for does not exist or has moved.",

  "common.dataGrid.empty": "No entries.",
  "common.dataGrid.resetWidths": "Reset column widths",
  "common.dataGrid.resizeColumn": "Resize column: {name}",
  "common.dataGrid.resizeHelp":
    "Drag or use arrow keys to resize. Double-click or press Enter to fit content.",
  "common.dataGrid.filterPlaceholder": "Filter…",
  "common.dataGrid.filterLabel": "Search table",

  "common.cancel": "Cancel",
  "common.saving": "Saving…",
  "common.creating": "Creating…",
  "common.optional": "Optional",
  "common.all": "All",
  "common.import": "Import",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.add": "Add",

  "common.csv.expectedColumns": "Expected columns",
  "common.csv.preview": "Preview",
  "common.csv.commit": "Import {count}",
  "common.csv.valid": "valid",
  "common.csv.invalid": "invalid",
  "common.csv.line": "Line {line}",
} satisfies Record<keyof typeof commonDe, string>;
