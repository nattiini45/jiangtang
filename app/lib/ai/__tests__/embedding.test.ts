import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "~/lib/ai/embedding.server";
import { AiProviderError } from "~/lib/ai/openai-compat.server";
import { DEFAULT_QUERY_INSTRUCTION, type EmbeddingConfig } from "~/lib/ai/config.server";
import { mockHttp, type MockServer } from "../../../../test/helpers/mock-http";

/**
 * The `api` embedding provider against a loopback mock. Nothing here
 * leaves 127.0.0.1.
 */
let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function cfg(over: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    model: "qwen3-embedding",
    baseUrl: server!.url,
    dimensions: 1024,
    sendDimensions: true,
    queryTemplate: "Instruct: {instruction}\nQuery:{text}",
    queryInstruction: DEFAULT_QUERY_INSTRUCTION,
    passageTemplate: "{text}",
    ...over,
  };
}

/** A unit vector with `v[0] = 1`. */
function unit(): number[] {
  const v = new Array<number>(1024).fill(0);
  v[0] = 1;
  return v;
}

const okReply = (n: number) => ({
  json: { data: Array.from({ length: n }, (_, index) => ({ index, embedding: unit() })) },
});

describe("api embedding provider", () => {
  it("sends dimensions:1024 and the Bearer header only when a key is set", async () => {
    server = await mockHttp(() => okReply(1));
    const withKey = createEmbeddingProvider(cfg({ apiKey: "sk-test" }));
    await withKey.embed(["x"], "passage");
    expect(JSON.parse(server.requests[0].body)).toMatchObject({
      model: "qwen3-embedding",
      dimensions: 1024,
    });
    expect(server.requests[0].headers.authorization).toBe("Bearer sk-test");

    server = await mockHttp(() => okReply(1));
    const keyless = createEmbeddingProvider(cfg());
    await keyless.embed(["x"], "passage");
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it("omits `dimensions` when sendDimensions is false", async () => {
    server = await mockHttp(() => okReply(1));
    const p = createEmbeddingProvider(cfg({ sendDimensions: false }));
    await p.embed(["x"], "passage");
    expect("dimensions" in JSON.parse(server.requests[0].body)).toBe(false);
  });

  it("retries a batch without `dimensions` when the 400 body says so", async () => {
    let calls = 0;
    server = await mockHttp(() => {
      calls++;
      return calls === 1 ? { status: 400, text: "unknown field `dimensions`" } : okReply(1);
    });
    const p = createEmbeddingProvider(cfg());
    const v = await p.embed(["x"], "passage");
    expect(v[0]).toHaveLength(1024);
    expect(server.requests).toHaveLength(2);
    expect("dimensions" in JSON.parse(server.requests[1].body)).toBe(false);
  });

  it("the query template applies to queries only — exactly the pinned default", async () => {
    server = await mockHttp(() => okReply(1));
    const p = createEmbeddingProvider(cfg());
    await p.embed(["was ist kaputt"], "query");
    expect(JSON.parse(server.requests[0].body).input[0]).toBe(
      `Instruct: ${DEFAULT_QUERY_INSTRUCTION}\nQuery:was ist kaputt`,
    );
    await p.embed(["Beamer A.01"], "passage");
    expect(JSON.parse(server.requests[1].body).input[0]).toBe("Beamer A.01");
  });

  it("batches 70 inputs into 3 requests and reorders by data[].index", async () => {
    server = await mockHttp((req) => {
      const { input } = JSON.parse(req.body);
      // Marker vector: a 1 at position `index`, results returned reversed —
      // data[].index is the contract, not array order.
      return {
        json: {
          data: input
            .map((_text: string, index: number) => ({
              index,
              embedding: unit().map((_x, i) => (i === index ? 1 : 0)),
            }))
            .reverse(),
        },
      };
    });
    const p = createEmbeddingProvider(cfg());
    const texts = Array.from({ length: 70 }, (_, i) => `text-${i}`);
    const out = await p.embed(texts, "passage");
    expect(server.requests).toHaveLength(3); // 32 + 32 + 6
    expect(server.requests.map((r) => JSON.parse(r.body).input.length)).toEqual([32, 32, 6]);
    for (let i = 0; i < out.length; i++) {
      expect(out[i][i % 32]).toBe(1); // input i carried marker index i % 32
    }
  });

  it("truncates a longer vector to 1024 and L2-normalises (Matryoshka)", async () => {
    // 4096-d: v[0]=3, v[1023]=4 inside the cut; a huge value past 1024 must not leak.
    const wide = new Array<number>(4096)
      .fill(0)
      .map((_, i) => (i === 0 ? 3 : i === 1023 ? 4 : i === 2000 ? 999 : 0));
    server = await mockHttp(() => ({ json: { data: [{ index: 0, embedding: wide }] } }));
    const p = createEmbeddingProvider(cfg());
    const [v] = await p.embed(["x"], "passage");
    expect(v).toHaveLength(1024);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(3 / 5, 6);
    expect(v[1023]).toBeCloseTo(4 / 5, 6);
  });

  it("a short vector is an error, not a silent pad", async () => {
    server = await mockHttp(() => ({
      json: { data: [{ index: 0, embedding: unit().slice(0, 384) }] },
    }));
    const p = createEmbeddingProvider(cfg());
    await expect(p.embed(["x"], "passage")).rejects.toThrow(/384/);
  });

  it("non-finite values are an error", async () => {
    server = await mockHttp(() => ({
      json: { data: [{ index: 0, embedding: [Infinity, ...unit().slice(1)] }] },
    }));
    const p = createEmbeddingProvider(cfg());
    await expect(p.embed(["x"], "passage")).rejects.toThrow(AiProviderError);
  });

  it("retries a 503 once, then gives up typed", async () => {
    let calls = 0;
    server = await mockHttp(() => {
      calls++;
      return calls < 3 ? { status: 503, text: "busy" } : okReply(1);
    });
    const p = createEmbeddingProvider(cfg());
    await expect(p.embed(["x"], "passage")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(2); // one retry, not a loop
  });

  it("the API key is never in the error text", async () => {
    server = await mockHttp(() => ({ status: 401, text: "unauthorized" }));
    const p = createEmbeddingProvider(cfg({ apiKey: "sk-very-secret" }));
    const err = await p.embed(["x"], "passage").catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(`${err.message} ${err.bodyExcerpt}`).not.toContain("sk-very-secret");
    expect(JSON.stringify(server.requests[0].headers.authorization)).toContain("sk-very-secret");
  });
});
