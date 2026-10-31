import { afterEach, describe, expect, it } from "vitest";
import { createRerankerProvider, passthroughReranker } from "~/lib/ai/reranker.server";
import { mockHttp, type MockServer } from "../../../../test/helpers/mock-http";

/** The reranker seam: both response spellings, and the `none` pass-through. */

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("api reranker", () => {
  it("posts { model, query, documents, top_n } and reads relevance_score", async () => {
    server = await mockHttp(() => ({
      json: {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      },
    }));
    const r = createRerankerProvider({ model: "bge", baseUrl: server.url });
    const out = await r.rerank("q", ["a", "b", "c"]);
    const body = JSON.parse(server.requests[0].body);
    expect(body).toMatchObject({ model: "bge", query: "q", documents: ["a", "b", "c"], top_n: 3 });
    expect(out).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
  });

  it("accepts `score` when the endpoint uses that spelling", async () => {
    server = await mockHttp(() => ({ json: { results: [{ index: 1, score: 7.5 }] } }));
    const r = createRerankerProvider({ model: "jina", baseUrl: server.url });
    expect(await r.rerank("q", ["a", "b"])).toEqual([{ index: 1, score: 7.5 }]);
  });
});

describe("none reranker", () => {
  it("passes input order through with descending synthetic scores", async () => {
    const out = await passthroughReranker.rerank("q", ["a", "b", "c"]);
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.map((r) => r.score)).toEqual([3, 2, 1]);
    expect(passthroughReranker.id).toBe("none");
  });
});
