import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_COUNTS } from "../scripts/seed/data";
import { seedDataFor } from "../scripts/seed/localized";

/**
 * The English demo set is an overlay on the German rows: it must keep every
 * structural fact (ids, relations, counts, enums) and replace all wording.
 */

const de = seedDataFor("de");
const en = seedDataFor("en");

const STRUCTURAL = ["id", "status", "priority", "kind", "type", "parentId", "projectId"] as const;

function texts(rows: readonly object[]): string[] {
  return rows.flatMap((row) =>
    Object.values(row).flatMap((v) =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [],
    ),
  );
}

describe("seedDataFor", () => {
  it("English has the same counts as German and as EXPECTED_COUNTS", () => {
    for (const data of [de, en]) {
      expect(data.ROOMS).toHaveLength(EXPECTED_COUNTS.room);
      expect(data.EQUIPMENT_MODELS).toHaveLength(EXPECTED_COUNTS.equipmentModel);
      expect(data.EQUIPMENT).toHaveLength(EXPECTED_COUNTS.equipment);
      expect(data.EVENTS).toHaveLength(EXPECTED_COUNTS.event);
      expect(data.LOCATIONS).toHaveLength(EXPECTED_COUNTS.location);
      expect(data.PROJECTS).toHaveLength(EXPECTED_COUNTS.project);
      expect(data.TASKS).toHaveLength(EXPECTED_COUNTS.task);
      expect(data.TICKETS).toHaveLength(EXPECTED_COUNTS.ticket);
      expect(data.NOTES).toHaveLength(EXPECTED_COUNTS.note);
      expect(data.INVENTORY).toHaveLength(EXPECTED_COUNTS.inventoryItem);
      expect(data.VENDORS).toHaveLength(EXPECTED_COUNTS.vendor);
      expect(data.TIME_ENTRIES).toHaveLength(EXPECTED_COUNTS.timeEntry);
    }
  });

  it("keeps ids, relations, enums and numbers identical row by row", () => {
    for (const key of Object.keys(de) as (keyof typeof de)[]) {
      de[key].forEach((row, i) => {
        const other = en[key][i] as Record<string, unknown>;
        const base = row as Record<string, unknown>;
        for (const field of Object.keys(base)) {
          if (typeof base[field] === "string" && !STRUCTURAL.includes(field as never)) continue;
          if (Array.isArray(base[field])) continue;
          expect(other[field], `${key}[${i}].${field}`).toEqual(base[field]);
        }
        expect(other.id).toBe(base.id);
      });
    }
  });

  it("English wording shares no German words with the German set", () => {
    const germanOnly = /[äöüß]|\b(und|der|die|das|für|nicht|Demo-Raum|Aufgabe|Lager)\b/i;
    const offending = Object.values(en).flatMap((rows) =>
      texts(rows).filter((s) => germanOnly.test(s)),
    );
    expect(offending).toEqual([]);
  });

  it("English project slugs stay unique", () => {
    const slugs = en.PROJECTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).not.toEqual(de.PROJECTS.map((p) => p.slug));
  });
});

describe("workspace locale selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function projectNamesWritten(): Promise<string[]> {
    const { seedWorkspace } = await import("../scripts/seed/workspace-seed");
    const names: string[] = [];
    const tx = new Proxy(
      {},
      {
        get: (_t, model: string) => ({
          findUnique: async () => null,
          findUniqueOrThrow: async () => ({ startsAt: new Date(), endsAt: new Date() }),
          create: async ({ data }: { data: { name?: string } }) => {
            if (model === "project" && data.name) names.push(data.name);
            return { id: "x" };
          },
        }),
      },
    );
    await seedWorkspace(tx as never, (async () => undefined) as never);
    return names;
  }

  it("seeds English names under DEFAULT_LOCALE=en and German under de", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    expect(await projectNamesWritten()).toContain("Room Technology Demo");
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(await projectNamesWritten()).toContain("Raumtechnik Demo");
  });
});
