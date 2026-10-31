import { db } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import type { EquipmentStatus, MicKind } from "~/generated/prisma/client";

/** Read-only microphone frequency coordination board (read-only).
 *
 * Wireless mics that share a frequency inside the same building can transmit over
 * each other. We surface every unit that has a frequency assigned, group it by
 * building, and flag clashes so the operator can re-plan channels.
 *
 * Decimal frequencyMhz is stringified at the boundary (loader payloads stay
 * JSON-serializable) — same pattern as inventory.queries.server.ts. */

// Statuses that count for clash detection: a unit only occupies its frequency
// on air when it is actually deployed. OPERATIONAL is live; MAINTENANCE units
// are still installed/racked and may transmit during a check, so they count too.
// FAULTY (broken, off air) and RETIRED (removed) never transmit → excluded from
// clash detection, but they ARE still listed so the operator sees the stock.
const CLASH_ACTIVE_STATUSES: readonly EquipmentStatus[] = ["OPERATIONAL", "MAINTENANCE"];

/** Decimal(8,3) → fixed 3-decimal string, e.g. "823.100" (Prisma's toString()
 * drops trailing zeros, giving "823.1"; the coordination view wants MHz to the
 * kHz, so we normalize here — this is also the stable clashKey / group key). */
function formatMhz(value: { toFixed: (n: number) => string }): string {
  return value.toFixed(3);
}

export interface FrequencyRow {
  id: string;
  name: string | null;
  /** Stringified Decimal, fixed to 3 decimals e.g. "823.100". */
  frequencyMhz: string;
  band: string | null;
  channelLabel: string | null;
  micKind: MicKind | null;
  status: EquipmentStatus;
  roomName: string | null;
  /** true when this unit shares its frequency with ≥1 other active unit in the same building. */
  clash: boolean;
  /** The shared frequency (== frequencyMhz) when clash, else null — lets the UI pair rows. */
  clashKey: string | null;
  /** Names of the other clashing units in this building (for the warning marker). */
  clashPartners: string[];
}

export interface FrequencyGroup {
  /** Building id, or "__pool__" for the roomless/pool bucket. */
  key: string;
  campusName: string | null;
  buildingName: string;
  /** true for the synthetic roomless/pool group (never participates in clash detection). */
  isPool: boolean;
  rows: FrequencyRow[];
  frequencyCount: number;
  clashCount: number;
}

const POOL_KEY = "__pool__";

function displayName(name: string | null, id: string): string {
  return name?.trim() ? name : `#${id.slice(-6)}`;
}

export async function listFrequencyBoard(): Promise<FrequencyGroup[]> {
  const items = await db.equipment.findMany({
    where: { frequencyMhz: { not: null } },
    select: {
      id: true,
      name: true,
      frequencyMhz: true,
      band: true,
      channelLabel: true,
      micKind: true,
      status: true,
      room: {
        select: {
          name: true,
          building: {
            select: { id: true, name: true, campus: { select: { name: true } } },
          },
        },
      },
    },
  });

  // Bucket by building; roomless (pool) units and units in a room with no
  // building go into the synthetic pool group, excluded from clash detection.
  interface Bucket {
    key: string;
    campusName: string | null;
    buildingName: string;
    isPool: boolean;
    rows: FrequencyRow[];
  }
  const buckets = new Map<string, Bucket>();

  for (const e of items) {
    const freq = formatMhz(e.frequencyMhz!);
    const building = e.room?.building ?? null;
    const isPool = building === null;
    const key = isPool ? POOL_KEY : building.id;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        campusName: isPool ? null : (building.campus?.name ?? null),
        buildingName: isPool ? tr("places.err.frequency.poolBucket") : building.name,
        isPool,
        rows: [],
      };
      buckets.set(key, bucket);
    }

    bucket.rows.push({
      id: e.id,
      name: e.name,
      frequencyMhz: freq,
      band: e.band,
      channelLabel: e.channelLabel,
      micKind: e.micKind,
      status: e.status,
      roomName: e.room?.name ?? null,
      clash: false,
      clashKey: null,
      clashPartners: [],
    });
  }

  // Detect clashes within each non-pool building: same frequency shared by ≥2
  // active units. Only active units both trigger and appear as partners.
  for (const bucket of buckets.values()) {
    if (bucket.isPool) continue;

    const byFreq = new Map<string, FrequencyRow[]>();
    for (const row of bucket.rows) {
      if (!CLASH_ACTIVE_STATUSES.includes(row.status)) continue;
      const list = byFreq.get(row.frequencyMhz);
      if (list) list.push(row);
      else byFreq.set(row.frequencyMhz, [row]);
    }

    for (const [freq, group] of byFreq) {
      if (group.length < 2) continue;
      for (const row of group) {
        row.clash = true;
        row.clashKey = freq;
        row.clashPartners = group
          .filter((other) => other.id !== row.id)
          .map((other) => displayName(other.name, other.id));
      }
    }
  }

  const numericFreq = (s: string) => Number.parseFloat(s);

  const groups: FrequencyGroup[] = Array.from(buckets.values()).map((bucket) => {
    const rows = [...bucket.rows].sort(
      (a, b) =>
        numericFreq(a.frequencyMhz) - numericFreq(b.frequencyMhz) ||
        (a.channelLabel ?? "").localeCompare(b.channelLabel ?? "", "de"),
    );
    const distinctFreqs = new Set(rows.map((r) => r.frequencyMhz));
    const clashCount = rows.filter((r) => r.clash).length;
    return {
      key: bucket.key,
      campusName: bucket.campusName,
      buildingName: bucket.buildingName,
      isPool: bucket.isPool,
      rows,
      frequencyCount: distinctFreqs.size,
      clashCount,
    };
  });

  // Real buildings first (sorted by campus then building name), pool bucket last.
  groups.sort((a, b) => {
    if (a.isPool !== b.isPool) return a.isPool ? 1 : -1;
    return (
      (a.campusName ?? "").localeCompare(b.campusName ?? "", "de") ||
      a.buildingName.localeCompare(b.buildingName, "de")
    );
  });

  return groups;
}
