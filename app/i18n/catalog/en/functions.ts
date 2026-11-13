import type { functionsDe } from "../de/functions";
export const functionsEn = {
  "functions.title": "Functions",
  "functions.empty": "No function is served by devices yet.",
  "functions.state.NO_KNOWN_FAULT": "No known fault",
  "functions.state.LIMITED": "Limited",
  "functions.state.DOWN": "Doesn't work",
  "functions.never": "Never confirmed",
  "functions.since": "Since {date}",
  "functions.before": "Since before {date}",
  "functions.report": "Report fault",
  "functions.roomHint":
    "At least one function doesn't work. The room status is independent of this.",
  "functions.impact": "Impact",
  "functions.choose": "Choose a function",
  "functions.note": "Note (optional)",
  "functions.offline":
    "Offline: the fault has not been saved. The form stays here so you can retry.",
  "functions.error.impact": "Only a fault can have an impact.",
  "functions.error.function": "Choose a function and a device belonging to it in this room.",
  "functions.error.required": "Choose a room, a function and an impact.",
  "functions.error.kindInUse":
    "This device kind belongs to a function and cannot be deleted. Leave it archived.",
  "functions.optional": "Photo and device (optional)",
  "functions.faultTitle": "{function}: {impact}",
  "functions.saved": "Fault saved",
  "functions.back": "Back to room",
} satisfies Record<keyof typeof functionsDe, string>;
