import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import type { GenerationProvider } from "~/lib/ai/types";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { fakeGenerator } from "./helpers/ai-fakes";
import { prepareChunk } from "~/lib/search/chunking";
import type { SearchHit } from "~/lib/search/query.server";
import {
  askSystemPrompt,
  buildAskContext,
  buildAskMessages,
  noAnswer,
  validateAnswer,
  type AskSource,
} from "~/lib/search/ask.server";

/**
 * The Ask surface: prompt assembly, citation validation, and the SSE
 * route. Route tests mock `hybridSearch` (retrieval is covered in the search tests) and
 * `requireUser`, but run `buildAskContext` against real Chunk rows so the
 * sources event carries real assembled context.
 */

const RUN = `ask_${Date.now().toString(36)}`;
const SRC_ID = `${RUN}-src`;
const chunkIds: string[] = [];

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => ({ id: `${RUN}-user`, role: "MEMBER" }) as AuthUser),
  };
});

let scriptedHits: SearchHit[] = [];
vi.mock("~/lib/search/query.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/search/query.server")>();
  return {
    ...actual,
    hybridSearch: vi.fn(async () => ({ results: scriptedHits, degraded: [] })),
  };
});

const apiAsk = await import("~/routes/api.ask/route");

const hit: SearchHit = {
  sourceType: "ASKTEST",
  sourceId: SRC_ID,
  ordinal: 0,
  title: "Mischpult Yamaha",
  snippet: "s",
  snippetHtml: "s",
  href: null,
  score: 0.5,
  arms: ["and"],
  moreOrdinals: [1, 2],
};

const sampleSource: AskSource = {
  n: 1,
  sourceType: "EQUIPMENT",
  sourceId: "cmw12345678",
  ordinal: 0,
  title: "Yamaha DM7",
  headingPath: ["Technik", "Audio"],
  text: "Konsolentext",
  href: "/inventory/cmw12345678",
  anchor: "EQUIPMENT·cmw12345#0",
};

function askRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function readSseEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines
        .find((l) => l.startsWith("event:"))!
        .slice(6)
        .trim();
      const data = JSON.parse(
        lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n"),
      ) as unknown;
      return { event, data };
    });
}

/** A provider whose yields wait on manually-opened gates — lets tests abort or overlap. */
function gatedGenerator(chunks: string[]) {
  const gates: Array<() => void> = [];
  const stats = { pulls: 0, returned: false };
  const provider: GenerationProvider = {
    id: "gated@ask",
    async *generate() {
      try {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => gates.push(resolve));
          stats.pulls += 1;
          yield chunk;
        }
      } finally {
        stats.returned = true;
      }
    },
  };
  return {
    provider,
    openAll: () => gates.splice(0).forEach((r) => r()),
    stats,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeAll(async () => {
  for (const [ordinal, text] of [
    "Das Mischpult hängt in A.01.",
    "Seriennummer SN-YDM-0001.",
    "Ersatz liegt im Lager.",
  ].entries()) {
    const row = prepareChunk({
      sourceType: "ASKTEST",
      sourceId: SRC_ID,
      sourceTitle: "Mischpult Yamaha",
      ordinal,
      headingPath: ordinal === 0 ? ["Technik"] : [],
      text,
      sourceUpdatedAt: new Date(),
    });
    const created = await db.chunk.create({ data: row });
    chunkIds.push(created.id);
  }
});

afterAll(async () => {
  resetAi();
  await db.chunk.deleteMany({ where: { id: { in: chunkIds } } });
});

describe("validateAnswer", () => {
  it("accepts a fully-cited answer", () => {
    const v = validateAnswer(
      "Der Empfänger hängt in A.01 [2].\n\nZwei Sender sind aktiv [1][2].",
      2,
    );
    expect(v.ok).toBe(true);
    expect(v.noAnswer).toBe(false);
    expect(v.paragraphs.map((p) => p.citations)).toEqual([[2], [1, 2]]);
    expect(v.invalidCitations).toEqual([]);
  });

  it("strips citation numbers outside 1..n", () => {
    const v = validateAnswer("Der Empfänger hängt in A.01 [9].", 2);
    expect(v.invalidCitations).toEqual([9]);
    expect(v.paragraphs[0]!.text).toBe("Der Empfänger hängt in A.01.");
    expect(v.paragraphs[0]!.uncited).toBe(true);
    expect(v.ok).toBe(false);
  });

  it("flags an uncited paragraph while keeping the cited one valid", () => {
    const v = validateAnswer("Aussage eins [1].\n\nAussage zwei ohne Beleg.", 3);
    expect(v.paragraphs[0]!.uncited).toBe(false);
    expect(v.paragraphs[1]!.uncited).toBe(true);
    expect(v.ok).toBe(false);
  });

  it.each([`„${noAnswer("de")}“`, noAnswer("de"), `  ${noAnswer("de")}  `])(
    "recognises the no-answer sentence %j",
    (text) => {
      const v = validateAnswer(text, 3);
      expect(v.noAnswer).toBe(true);
      expect(v.ok).toBe(true);
    },
  );

  it("rejects an empty answer", () => {
    const v = validateAnswer("   ", 3);
    expect(v.noAnswer).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.paragraphs).toEqual([]);
  });
});

describe("buildAskMessages / buildAskContext", () => {
  it("inserts the verbatim prompt with the formatted source list", () => {
    const [system, user] = buildAskMessages("Wo hängt das Pult?", [sampleSource]);
    expect(system!.role).toBe("system");
    expect(user!.role).toBe("user");
    expect(user!.content).toBe("Wo hängt das Pult?");
    expect(system!.content).not.toContain("{sources}");
    // The verbatim constant with the sources list spliced in.
    expect(system!.content).toBe(
      askSystemPrompt("de").replace(
        "{sources}",
        "[1] Gerät: Yamaha DM7 › Technik › Audio\nKonsolentext",
      ),
    );
    expect(system!.content).toContain("„Der Empfänger ist in A.01 eingebaut [2].“");
  });

  it("numbers sources 1..n and folds to one user message under merge", () => {
    const second = { ...sampleSource, n: 2, title: "Zweite Quelle", headingPath: [] };
    const [merged] = buildAskMessages("Frage?", [sampleSource, second], "merge");
    expect(merged!.role).toBe("user");
    expect(merged!.content).toContain("[1] Gerät: Yamaha DM7");
    expect(merged!.content).toContain("[2] Gerät: Zweite Quelle");
    expect(merged!.content.endsWith("Frage?")).toBe(true);
    // merge: no system role is emitted.
    const msgs = buildAskMessages("Frage?", [sampleSource, second], "merge");
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
  });

  it("assembles cited + trailing chunks of a source, ≤1500 chars each", async () => {
    const sources = await buildAskContext([hit]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.n).toBe(1);
    expect(sources[0]!.headingPath).toEqual(["Technik"]);
    expect(sources[0]!.text).toContain("hängt in A.01");
    expect(sources[0]!.text).toContain("Seriennummer SN-YDM-0001");
    expect(sources[0]!.text).toContain("Ersatz liegt im Lager");
    expect(sources[0]!.anchor).toBe(`ASKTEST·${SRC_ID.slice(0, 8)}#0`);
  });
});

describe("api.ask", () => {
  it("streams sources → deltas → done over SSE", async () => {
    scriptedHits = [hit];
    setAiForTests({ generation: fakeGenerator(["Der Raum ist ", "A.01 [1]."]) });
    const res = await apiAsk.action({
      request: askRequest({ question: "Wo hängt das Pult?" }),
    } as never);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const events = await readSseEvents(res);
    expect(events.map((e) => e.event)).toEqual(["sources", "delta", "delta", "done"]);

    const sources = events[0]!.data as {
      n: number;
      title: string;
      href: string | null;
      anchor: string;
    }[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.n).toBe(1);
    expect(sources[0]!.title).toBe("Mischpult Yamaha");
    expect(sources[0]!.anchor).toBe(`ASKTEST·${SRC_ID.slice(0, 8)}#0`);

    const done = events[3]!.data as { ok: boolean; paragraphs: { citations: number[] }[] };
    expect(done.ok).toBe(true);
    expect(done.paragraphs[0]!.citations).toEqual([1]);
  });

  it("returns results-only when no generation provider is configured", async () => {
    scriptedHits = [hit];
    setAiForTests({ generation: null });
    const res = await apiAsk.action({
      request: askRequest({ question: "Wo hängt das Pult?" }),
    } as never);
    const data = (await res.json()) as { mode: string; reason: string; results: unknown[] };
    expect(res.status).toBe(200);
    expect(data.mode).toBe("results-only");
    expect(data.reason).toBe(
      "Antworten benötigen ein Modell — GENERATION_BASE_URL ist nicht gesetzt.",
    );
    expect(data.results).toHaveLength(1);
  });

  it("returns no-sources when retrieval finds nothing", async () => {
    scriptedHits = [];
    setAiForTests({ generation: fakeGenerator(["x"]) });
    const res = await apiAsk.action({
      request: askRequest({ question: "Nichts da" }),
    } as never);
    expect((await res.json()) as unknown).toEqual({ mode: "no-sources" });
  });

  it("refuses a second in-flight ask with 429 and releases after", async () => {
    scriptedHits = [hit];
    const { provider, openAll, stats } = gatedGenerator(["a", "b", "c"]);
    setAiForTests({ generation: provider });

    const res1 = await apiAsk.action({ request: askRequest({ question: "eins" }) } as never);
    openAll(); // let the first delta in — the ask is now in flight
    await tick();

    const res2 = await apiAsk.action({ request: askRequest({ question: "zwei" }) } as never);
    expect(res2.status).toBe(429);
    expect((await res2.json()) as { error: string }).toEqual({
      error: "Es läuft bereits eine Anfrage.",
    });

    // Each gate is pushed in a microtask — tick between opens so none is missed.
    for (let i = 0; i < 3; i++) {
      openAll();
      await tick();
    }
    await res1.text();
    expect(stats.returned).toBe(true);

    // Swap to a self-draining provider — the gated one would hang on a new ask.
    setAiForTests({ generation: fakeGenerator(["ok [1]."]) });
    const res3 = await apiAsk.action({ request: askRequest({ question: "drei" }) } as never);
    expect(res3.status).toBe(200);
    await res3.text(); // drain so the slot frees
  });

  it("stops the provider iterator when the request aborts", async () => {
    scriptedHits = [hit];
    const { provider, openAll, stats } = gatedGenerator(["a", "b", "c", "d"]);
    setAiForTests({ generation: provider });
    const ac = new AbortController();

    await apiAsk.action({ request: askRequest({ question: "abbruch" }, ac.signal) } as never);
    openAll(); // first delta streams
    await tick();
    ac.abort();
    for (let i = 0; i < 3; i++) {
      openAll();
      await tick();
    }

    expect(stats.returned).toBe(true); // break → iterator.return() → finally
    expect(stats.pulls).toBeLessThan(4);
  });
});

describe("prompt and no-answer sentence follow the workspace locale", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("selects the German prompt and sentence for de", () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    const [system] = buildAskMessages("Wo?", [sampleSource]);
    expect(system!.content).toContain("Du bist der Assistent eines Medientechnik-Arbeitsbereichs");
    expect(system!.content).toContain(`„${noAnswer()}“`);
    expect(noAnswer()).toBe("Dazu finde ich nichts in den Quellen.");
  });

  it("selects the English prompt and sentence for en, with sources spliced in", () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    const [system, user] = buildAskMessages("Where?", [sampleSource]);
    expect(system!.content).toContain("You are the assistant of a media-technology workspace");
    expect(system!.content).toContain(`“${noAnswer()}”`);
    expect(system!.content).toContain("[1] Equipment: Yamaha DM7 › Technik › Audio");
    expect(system!.content).not.toContain("{sources}");
    expect(system!.content).not.toMatch(/Beantworte|Quellen:/);
    expect(user!.content).toBe("Where?");
    expect(noAnswer()).toBe("I can't find anything about that in the sources.");
  });

  it("an explicit locale beats the environment", () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(askSystemPrompt("en")).toContain("Answer the question using only the numbered sources");
    expect(buildAskMessages("Q", [sampleSource], "system", "en")[0]!.content).toContain("Sources:");
  });

  it("accepts either language's no-answer sentence, quoted or not", () => {
    for (const text of [
      noAnswer("en"),
      `“${noAnswer("en")}”`,
      noAnswer("de"),
      `„${noAnswer("de")}“`,
    ]) {
      const v = validateAnswer(text, 2);
      expect(v.noAnswer).toBe(true);
      expect(v.ok).toBe(true);
    }
    expect(validateAnswer("Something else.", 2).noAnswer).toBe(false);
  });
});
