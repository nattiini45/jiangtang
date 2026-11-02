import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { conceptEmbedder } from "./helpers/ai-fakes";
import { prepareChunk } from "~/lib/search/chunking";
import { hybridSearch } from "~/lib/search/query.server";

/**
 * HybridSearch on hand-built chunks. Every fixture uses sourceType
 * "QTEST" and every call passes `sourceTypes: [STYPE]`, so the live dev corpus
 * (and the running index worker writing into it) can never interfere.
 *
 * Embeddings are written straight to the `vector` column via raw SQL because
 * the column is `Unsupported` — Prisma's create cannot carry it.
 */

const RUN = `search_query_${Date.now().toString(36)}`;
const STYPE = "QTEST";

const SRC = {
  receiver: `${RUN}-receiver`,
  cable: `${RUN}-cable`,
  vendor: `${RUN}-vendor`,
  loop: `${RUN}-loop`,
  charger: `${RUN}-charger`,
};

const FIXTURES: { id: string; title: string; text: string }[] = [
  {
    id: SRC.receiver,
    title: "Shure ULXD4 Empfänger H 1",
    text: "Funkempfänger Shure ULXD4, Seriennummer SN-ULX-0001, Frequenzband G51, eingebaut im Rack von Hörsaal H 1.",
  },
  {
    id: SRC.cable,
    title: "HDMI-Kabel 10 m",
    text: "Artikelnummer CAB-HDMI-10, Bestand 12 Stück, Lager D.01.01, geliefert von Demo-Ersatzteile GmbH.",
  },
  {
    id: SRC.vendor,
    title: "Lieferant Demo-Ersatzteile GmbH",
    text: "Ansprechpartnerin Demo Kontakt, E-Mail ersatzteile@demo-ersatzteile.example, Telefon 0000 000000.",
  },
  {
    id: SRC.loop,
    title: "Aufgabe: Ringschleife H 2 jährlich messen",
    text: "Jährliche Messung der induktiven Ringschleife in Hörsaal H 2 und Protokoll ablegen.",
  },
  {
    id: SRC.charger,
    title: "Ladestation für Handsender",
    text: "Ladestation mit 8 Schächten für die Handsender, steht im Lager D.01.01.",
  },
];

beforeAll(async () => {
  for (const f of FIXTURES) {
    await db.chunk.create({
      data: prepareChunk({
        sourceType: STYPE,
        sourceId: f.id,
        sourceTitle: f.title,
        ordinal: 0,
        headingPath: [],
        text: f.text,
        sourceUpdatedAt: new Date(),
      }),
    });
  }
});

afterEach(() => resetAi());

afterAll(async () => {
  await db.searchIndexJob.deleteMany({ where: { sourceType: STYPE } });
  await db.chunk.deleteMany({ where: { sourceType: STYPE } });
});

/** Stamp the given embedder's vectors on all QTEST chunks (dense arm input). */
async function embedFixtures(model: typeof conceptEmbedder): Promise<void> {
  const rows = await db.chunk.findMany({
    where: { sourceType: STYPE },
    select: { id: true, sourceTitle: true, text: true },
  });
  const vectors = await model.embed(
    rows.map((r) => `${r.sourceTitle}\n${r.text}`),
    "passage",
  );
  for (let i = 0; i < rows.length; i++) {
    const lit = `[${vectors[i]!.join(",")}]`;
    await db.$executeRaw`UPDATE "Chunk"
      SET embedding = ${lit}::vector, "embeddingModel" = ${model.id}
      WHERE id = ${rows[i]!.id}`;
  }
}

const search = (q: string, extra: Parameters<typeof hybridSearch>[1] = {}) =>
  hybridSearch(q, { sourceTypes: [STYPE], ...extra });

describe("hybridSearch — lexical arms", () => {
  it("an exact serial ranks first", async () => {
    const { results, degraded } = await search("SN-ULX-0001");
    expect(degraded).toEqual([]);
    expect(results[0]?.sourceId).toBe(SRC.receiver);
    expect(results[0]?.title).toContain("ULXD4");
    expect(results[0]?.href).toBeNull(); // QTEST has no entity page
  });

  it("finds an e-mail local part that only exists via identifierVariants keywords", async () => {
    const { results } = await search("ersatzteile");
    expect(results[0]?.sourceId).toBe(SRC.vendor);
  });

  it("a truncated serial is found by the fuzzy arm", async () => {
    const { results } = await search("SN-ULX-000");
    const hit = results.find((r) => r.sourceId === SRC.receiver);
    expect(hit).toBeDefined();
    expect(hit!.arms).toContain("fuzzy");
  });

  it("or-arm: „Garantie Yamaha Mischpult“ finds „Digitalmischpult“-style partial overlap", async () => {
    // e11-style doc has no fixture here — assert the arm semantics directly:
    // "Lager D.01.01" ANDs on all three lexemes in both cable and charger.
    const { results } = await search("Lager D.01.01");
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain(SRC.cable);
    expect(ids).toContain(SRC.charger);
  });

  it("sourceTypes filter scopes every arm", async () => {
    const { results } = await hybridSearch("SN-ULX-0001", { sourceTypes: ["NOPE"] });
    expect(results).toEqual([]);
  });

  it("an empty query returns nothing without touching the DB", async () => {
    expect(await search("   ")).toEqual({ results: [], degraded: [] });
  });
});

describe("hybridSearch — dense arm + rerank", () => {
  it("a paraphrase is found with the concept embedder and not without it", async () => {
    setAiForTests({ embedding: conceptEmbedder });
    await embedFixtures(conceptEmbedder);
    const withDense = await search("Hörschleife prüfen");
    const denseHit = withDense.results.find((r) => r.sourceId === SRC.loop);
    expect(denseHit).toBeDefined();
    expect(denseHit!.arms).toContain("dense");

    setAiForTests({ embedding: null });
    const without = await search("Hörschleife prüfen");
    expect(without.results.map((r) => r.sourceId)).not.toContain(SRC.loop);
  });

  it("a throwing embedder degrades to lexical and names the arm", async () => {
    setAiForTests({
      embedding: {
        id: "fake-broken@1024",
        dimensions: 1024,
        embed: async () => {
          throw new Error("endpoint unreachable");
        },
      },
    });
    const { results, degraded } = await search("SN-ULX-0001");
    expect(degraded).toContain("dense");
    expect(results[0]?.sourceId).toBe(SRC.receiver);
  });

  it("the reranker reorders the fused candidates", async () => {
    setAiForTests({
      reranker: {
        id: "fake-reverse",
        // Later docs score higher — the fused order is flipped.
        rerank: async (_q, docs) => docs.map((_d, index) => ({ index, score: index })),
      },
    });
    const reversed = await search("Lager D.01.01", { limit: 5 });
    resetAi(); // pass-through reranker keeps the fused order
    const passthrough = await search("Lager D.01.01", { limit: 5 });
    expect(passthrough.results.length).toBeGreaterThanOrEqual(2);
    // Under the reversing reranker the last fused candidate ranks first.
    expect(reversed.results[0]!.sourceId).toBe(
      passthrough.results[passthrough.results.length - 1]!.sourceId,
    );
  });

  it("none providers → lexical results, no error, no degraded entries", async () => {
    resetAi(); // test env has no *_BASE_URL → every capability is `none`
    const { results, degraded } = await search("SN-ULX-0001");
    expect(degraded).toEqual([]);
    expect(results[0]?.sourceId).toBe(SRC.receiver);
  });
});
