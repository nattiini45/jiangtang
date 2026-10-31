import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { listFrequencyBoard } from "~/domains/inventory/inventory.frequency.server";
import type { FrequencyGroup } from "~/domains/inventory/inventory.frequency.server";

// Unique run prefix; every row we create is prefixed so we can find & delete only ours.
const RUN = `freq_${Date.now()}`;
const ids = {
  campus: `${RUN}_c`,
  buildingA: `${RUN}_bA`,
  buildingB: `${RUN}_bB`,
  roomA: `${RUN}_rA`,
  roomB: `${RUN}_rB`,
};
const equipmentIds: string[] = [];

async function mkMic(over: {
  id: string;
  name: string;
  freq: string;
  status?: "OPERATIONAL" | "FAULTY" | "MAINTENANCE" | "RETIRED";
  roomId?: string | null;
}) {
  const eq = await db.equipment.create({
    data: {
      id: over.id,
      category: "MICROPHONE",
      status: over.status ?? "OPERATIONAL",
      mobility: over.roomId ? "FIXED" : "POOLED",
      name: over.name,
      micKind: "HANDHELD",
      frequencyMhz: over.freq,
      band: "G-Band",
      channelLabel: "Funk 1",
      roomId: over.roomId ?? null,
    },
  });
  equipmentIds.push(eq.id);
  return eq;
}

/** Find our synthetic groups within the full board (other tracks share the dev DB). */
function ownGroups(board: FrequencyGroup[]) {
  const byBuilding = (key: string) => board.find((g) => g.key === key);
  const pool = board.find((g) => g.isPool);
  return { A: byBuilding(ids.buildingA), B: byBuilding(ids.buildingB), pool };
}

beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.building.create({
    data: { id: ids.buildingA, campusId: ids.campus, name: `${RUN} Gebäude A` },
  });
  await db.building.create({
    data: { id: ids.buildingB, campusId: ids.campus, name: `${RUN} Gebäude B` },
  });
  await db.room.create({
    data: {
      id: ids.roomA,
      slug: ids.roomA,
      name: "FreqRoom A",
      campusId: ids.campus,
      buildingId: ids.buildingA,
    },
  });
  await db.room.create({
    data: {
      id: ids.roomB,
      slug: ids.roomB,
      name: "FreqRoom B",
      campusId: ids.campus,
      buildingId: ids.buildingB,
    },
  });
});

afterAll(async () => {
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.room.deleteMany({ where: { id: { in: [ids.roomA, ids.roomB] } } });
  await db.building.deleteMany({ where: { id: { in: [ids.buildingA, ids.buildingB] } } });
  await db.campus.deleteMany({ where: { id: ids.campus } });
  await db.$disconnect();
});

describe("listFrequencyBoard", () => {
  it("flags two active units on the same frequency in the same building with a matching clashKey", async () => {
    await mkMic({ id: `${RUN}_1`, name: `${RUN} Mic 1`, freq: "823.100", roomId: ids.roomA });
    await mkMic({ id: `${RUN}_2`, name: `${RUN} Mic 2`, freq: "823.100", roomId: ids.roomA });

    const { A } = ownGroups(await listFrequencyBoard());
    expect(A).toBeDefined();
    const r1 = A!.rows.find((r) => r.id === `${RUN}_1`)!;
    const r2 = A!.rows.find((r) => r.id === `${RUN}_2`)!;
    expect(r1.clash).toBe(true);
    expect(r2.clash).toBe(true);
    expect(r1.clashKey).toBe("823.100");
    expect(r2.clashKey).toBe("823.100");
    expect(r1.clashPartners).toContain(`${RUN} Mic 2`);
    expect(r2.clashPartners).toContain(`${RUN} Mic 1`);
    expect(A!.clashCount).toBe(2);
  });

  it("does not flag the same frequency across different buildings", async () => {
    await mkMic({ id: `${RUN}_3`, name: `${RUN} Mic 3`, freq: "790.500", roomId: ids.roomA });
    await mkMic({ id: `${RUN}_4`, name: `${RUN} Mic 4`, freq: "790.500", roomId: ids.roomB });

    const { A, B } = ownGroups(await listFrequencyBoard());
    const r3 = A!.rows.find((r) => r.id === `${RUN}_3`)!;
    const r4 = B!.rows.find((r) => r.id === `${RUN}_4`)!;
    expect(r3.clash).toBe(false);
    expect(r4.clash).toBe(false);
  });

  it("does not flag a retired or faulty unit sharing a frequency with one active unit", async () => {
    await mkMic({
      id: `${RUN}_5`,
      name: `${RUN} Mic 5 active`,
      freq: "710.250",
      roomId: ids.roomB,
    });
    await mkMic({
      id: `${RUN}_6`,
      name: `${RUN} Mic 6 retired`,
      freq: "710.250",
      status: "RETIRED",
      roomId: ids.roomB,
    });
    await mkMic({
      id: `${RUN}_7`,
      name: `${RUN} Mic 7 faulty`,
      freq: "710.250",
      status: "FAULTY",
      roomId: ids.roomB,
    });

    const { B } = ownGroups(await listFrequencyBoard());
    const active = B!.rows.find((r) => r.id === `${RUN}_5`)!;
    const retired = B!.rows.find((r) => r.id === `${RUN}_6`)!;
    const faulty = B!.rows.find((r) => r.id === `${RUN}_7`)!;
    // Only one active unit on 710.250 → no clash; retired/faulty are listed but never flagged.
    expect(active.clash).toBe(false);
    expect(retired.clash).toBe(false);
    expect(faulty.clash).toBe(false);
    // All three still appear in the board.
    expect([active, retired, faulty].map((r) => r.id).sort()).toEqual(
      [`${RUN}_5`, `${RUN}_6`, `${RUN}_7`].sort(),
    );
  });

  it("lists roomless (pool) equipment in the pool group and never marks it as a clash", async () => {
    await mkMic({ id: `${RUN}_8`, name: `${RUN} Pool Mic 8`, freq: "838.700", roomId: null });
    await mkMic({ id: `${RUN}_9`, name: `${RUN} Pool Mic 9`, freq: "838.700", roomId: null });

    const { pool } = ownGroups(await listFrequencyBoard());
    expect(pool).toBeDefined();
    const p8 = pool!.rows.find((r) => r.id === `${RUN}_8`)!;
    const p9 = pool!.rows.find((r) => r.id === `${RUN}_9`)!;
    expect(p8).toBeDefined();
    expect(p9).toBeDefined();
    // Same frequency, but pool bucket is excluded from clash detection.
    expect(p8.clash).toBe(false);
    expect(p9.clash).toBe(false);
    expect(pool!.isPool).toBe(true);
  });
});
