import type { EquipmentCategory } from "~/generated/prisma/client";

export const DEFAULT_FUNCTION_GROUPS = [
  { key: "display", de: "Anzeige", en: "Display", position: 1 },
  { key: "source", de: "Quellen und Eingänge", en: "Sources and inputs", position: 2 },
  { key: "switching", de: "Schaltung", en: "Switching", position: 4 },
  { key: "audio", de: "Audio", en: "Audio", position: 5 },
  { key: "control", de: "Steuerung", en: "Control", position: 6 },
  { key: "capture", de: "Aufnahme und Regie", en: "Capture and production", position: 7 },
  { key: "other", de: "Sonstiges", en: "Other", position: 18 },
] as const;

export const DEFAULT_EQUIPMENT_KINDS = {
  PROJECTOR: { key: "projector", group: "display", de: "Projektor", en: "Projector" },
  PC: { key: "computer", group: "source", de: "PC", en: "PC" },
  MICROPHONE: { key: "microphone", group: "audio", de: "Mikrofon", en: "Microphone" },
  MEDIA_CONTROL: {
    key: "control_processor",
    group: "control",
    de: "Mediensteuerung",
    en: "Media control",
  },
  AUDIO: { key: "audio_equipment", group: "audio", de: "Audio", en: "Audio" },
  RECORDER: { key: "recorder", group: "capture", de: "Aufzeichnung", en: "Recorder" },
  SMARTBOARD: { key: "interactive_display", group: "display", de: "Smartboard", en: "Smartboard" },
  REMOTE: { key: "remote", group: "control", de: "Fernbedienung", en: "Remote control" },
  SWITCHER: { key: "presentation_switcher", group: "switching", de: "Switcher", en: "Switcher" },
  OTHER: { key: "other", group: "other", de: "Sonstiges", en: "Other" },
} as const satisfies Record<
  EquipmentCategory,
  { key: string; group: string; de: string; en: string }
>;
