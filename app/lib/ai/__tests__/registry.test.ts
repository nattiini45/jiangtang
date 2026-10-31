import { afterEach, describe, expect, it } from "vitest";
import { getAi, resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { hashEmbedder } from "../../../../test/helpers/ai-fakes";

/** Lazy process-level resolution + test injection. */

afterEach(() => resetAi());

describe("getAi registry", () => {
  it("resolves once per process and reports statuses", () => {
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    const a = getAi();
    const b = getAi();
    expect(a).toBe(b);
    expect(a.embedding).toBeNull();
    expect(a.generation).toBeNull();
    expect(a.reranker.id).toBe("none");
    expect(a.statuses.map((s) => s.state)).toEqual(["none", "none", "none"]);
  });

  it("setAiForTests injects providers without touching the environment", () => {
    setAiForTests({ embedding: hashEmbedder });
    expect(getAi().embedding?.id).toBe("fake-hash@1024");
    resetAi();
    expect(getAi().embedding).toBeNull();
  });

  it("an injected generation provider streams", async () => {
    setAiForTests({
      generation: {
        id: "fake-generation",
        async *generate() {
          yield "Hallo";
          yield "!";
        },
      },
    });
    const g = getAi().generation!;
    let out = "";
    for await (const c of g.generate([{ role: "user", content: "hi" }])) out += c;
    expect(out).toBe("Hallo!");
  });
});
