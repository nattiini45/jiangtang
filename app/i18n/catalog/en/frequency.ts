import type { frequencyDe } from "../de/frequency";

export const frequencyEn = {
  "frequency.meta.title": "Frequencies · Jiangtang",
  "frequency.title": "Frequency coordination",
  "frequency.subtitle.prefix":
    "Wireless links per building · same frequency in the same building =",
  "frequency.subtitle.clash": "clash",
  "frequency.empty": "No wireless links recorded.",
  "frequency.count.one": "frequency",
  "frequency.count.other": "frequencies",
  "frequency.clash.one": "clash",
  "frequency.clash.other": "clashes",
  "frequency.col.frequency": "Frequency",
  "frequency.col.band": "Band",
  "frequency.col.channel": "Channel",
  "frequency.col.device": "Device",
  "frequency.col.type": "Type",
  "frequency.col.room": "Room",
  "frequency.col.status": "Status",
  "frequency.clash.title": "Frequency clash with: {partners}",
  "frequency.clash.badge": "⚠ Clash: {partners}",
} satisfies Record<keyof typeof frequencyDe, string>;
