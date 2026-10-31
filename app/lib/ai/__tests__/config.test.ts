import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATION_MAX_TOKENS,
  DEFAULT_PASSAGE_TEMPLATE,
  DEFAULT_QUERY_INSTRUCTION,
  DEFAULT_QUERY_TEMPLATE,
  readAiConfig,
} from "~/lib/ai/config.server";

/** Config matrix — resolution keys on the base URL, per capability. */

describe("readAiConfig — per-capability resolution", () => {
  it("nothing set → all three none", () => {
    const cfg = readAiConfig({});
    expect(cfg.embedding.state).toBe("none");
    expect(cfg.reranker.state).toBe("none");
    expect(cfg.generation.state).toBe("none");
    expect(cfg.statuses.map((s) => s.state)).toEqual(["none", "none", "none"]);
  });

  it("base URL + model → api; the key is optional (keyless self-hosted is valid)", () => {
    const cfg = readAiConfig({
      EMBEDDING_BASE_URL: "http://127.0.0.1:8080/v1/",
      EMBEDDING_MODEL: "Qwen3-Embedding-8B",
    });
    expect(cfg.embedding.state).toBe("api");
    if (cfg.embedding.state !== "api") return;
    expect(cfg.embedding.config.baseUrl).toBe("http://127.0.0.1:8080/v1"); // trailing slash stripped
    expect(cfg.embedding.config.apiKey).toBeUndefined();
    expect(cfg.embedding.config.dimensions).toBe(1024);
    expect(cfg.embedding.config.sendDimensions).toBe(true);
    expect(cfg.embedding.config.queryTemplate).toBe(DEFAULT_QUERY_TEMPLATE);
    expect(cfg.embedding.config.queryInstruction).toBe(DEFAULT_QUERY_INSTRUCTION);
    expect(cfg.embedding.config.passageTemplate).toBe(DEFAULT_PASSAGE_TEMPLATE);
  });

  it("statuses carry model + host — never the key or a credential-bearing URL", () => {
    const cfg = readAiConfig({
      RERANK_BASE_URL: "http://user:secret@reranker.local:9000",
      RERANK_MODEL: "bge-reranker",
      RERANK_API_KEY: "sk-should-never-appear",
    });
    const s = cfg.statuses.find((x) => x.capability === "reranker")!;
    expect(s).toEqual({
      capability: "reranker",
      state: "api",
      model: "bge-reranker",
      host: "reranker.local:9000",
    });
    expect(JSON.stringify(cfg.statuses)).not.toContain("secret");
  });

  it("base URL without model → misconfigured; model without base URL → misconfigured", () => {
    expect(readAiConfig({ EMBEDDING_BASE_URL: "http://x" }).embedding.state).toBe("misconfigured");
    expect(readAiConfig({ EMBEDDING_MODEL: "m" }).embedding.state).toBe("misconfigured");
    const half = readAiConfig({ GENERATION_API_KEY: "k" });
    expect(half.generation.state).toBe("misconfigured"); // a stray key is still a half-config
  });

  it("EMBEDDING_DIMENSIONS other than 1024 is refused — the column is vector(1024)", () => {
    const cfg = readAiConfig({
      EMBEDDING_BASE_URL: "http://x",
      EMBEDDING_MODEL: "m",
      EMBEDDING_DIMENSIONS: "4096",
    });
    expect(cfg.embedding.state).toBe("misconfigured");
    if (cfg.embedding.state === "misconfigured")
      expect(cfg.embedding.detail).toContain("vector(1024)");
  });

  it("EMBEDDING_SEND_DIMENSIONS parses false-ish values; templates must keep {text}", () => {
    const off = readAiConfig({
      EMBEDDING_BASE_URL: "http://x",
      EMBEDDING_MODEL: "m",
      EMBEDDING_SEND_DIMENSIONS: "False",
    });
    if (off.embedding.state !== "api") throw new Error("expected api");
    expect(off.embedding.config.sendDimensions).toBe(false);

    const bad = readAiConfig({
      EMBEDDING_BASE_URL: "http://x",
      EMBEDDING_MODEL: "m",
      EMBEDDING_QUERY_TEMPLATE: "no placeholder",
    });
    expect(bad.embedding.state).toBe("misconfigured");
  });

  it("generation: maxTokens default + validation, systemRole system|merge", () => {
    const base = { GENERATION_BASE_URL: "http://x", GENERATION_MODEL: "mistral" };
    const def = readAiConfig(base);
    if (def.generation.state !== "api") throw new Error("expected api");
    expect(def.generation.config.maxTokens).toBe(DEFAULT_GENERATION_MAX_TOKENS);
    expect(def.generation.config.systemRole).toBe("system");

    const merged = readAiConfig({
      ...base,
      GENERATION_SYSTEM_ROLE: "merge",
      GENERATION_MAX_TOKENS: "256",
    });
    if (merged.generation.state !== "api") throw new Error("expected api");
    expect(merged.generation.config.systemRole).toBe("merge");
    expect(merged.generation.config.maxTokens).toBe(256);

    expect(readAiConfig({ ...base, GENERATION_SYSTEM_ROLE: "nope" }).generation.state).toBe(
      "misconfigured",
    );
    expect(readAiConfig({ ...base, GENERATION_MAX_TOKENS: "abc" }).generation.state).toBe(
      "misconfigured",
    );
  });

  it("a misconfigured capability never drags the others down", () => {
    const cfg = readAiConfig({
      EMBEDDING_BASE_URL: "http://emb.local",
      EMBEDDING_MODEL: "m",
      RERANK_BASE_URL: "notaurl",
      RERANK_MODEL: "r",
    });
    expect(cfg.embedding.state).toBe("api");
    expect(cfg.reranker.state).toBe("misconfigured");
    expect(cfg.generation.state).toBe("none");
  });
});
