import { afterEach, describe, expect, it } from "vitest";
import { createGenerationProvider } from "~/lib/ai/generation.server";
import { mockHttp, type MockServer } from "../../../../test/helpers/mock-http";
import type { ChatMessage } from "~/lib/ai/types";

/** The streaming generation seam: SSE parsing + system-role merge. */

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function sseReply(text: string | Buffer) {
  return { text, contentType: "text/event-stream" };
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Antworte auf Deutsch." },
  { role: "user", content: "Was ist los in A.01?" },
];

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

describe("api generation provider — SSE", () => {
  it("parses delta.content across events and stops at [DONE]", async () => {
    server = await mockHttp(() =>
      sseReply(
        'data: {"choices":[{"delta":{"content":"Der Ton "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"fällt aus"}}]}\n\n' +
          'data: {"choices":[{"delta":{}}]}\n\n' +
          "data: [DONE]\n\n" +
          'data: {"choices":[{"delta":{"content":"NIE"}}]}\n\n',
      ),
    );
    const g = createGenerationProvider({
      model: "m",
      baseUrl: server.url,
      maxTokens: 800,
      systemRole: "system",
    });
    expect(await collect(g.generate(MESSAGES))).toBe("Der Ton fällt aus");
  });

  it("handles an event split across TCP chunks and ignores keep-alives", async () => {
    server = await mockHttp(() => ({
      stream: [
        ': keep-alive\n\ndata: {"choices":[{"delta":{"conten', // split mid-token
        't":"A"}}]}\n\ndata: {"choices',
        '":[{"delta":{"content":"B"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      contentType: "text/event-stream",
    }));
    const g = createGenerationProvider({
      model: "m",
      baseUrl: server.url,
      maxTokens: 800,
      systemRole: "system",
    });
    expect(await collect(g.generate(MESSAGES))).toBe("AB");
  });

  it("ignores comment lines inside an event block", async () => {
    server = await mockHttp(() =>
      sseReply(': hb\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    );
    const g = createGenerationProvider({
      model: "m",
      baseUrl: server.url,
      maxTokens: 800,
      systemRole: "system",
    });
    expect(await collect(g.generate(MESSAGES))).toBe("ok");
  });

  it("sends stream:true, temperature 0.2 and the configured max_tokens", async () => {
    server = await mockHttp(() => sseReply("data: [DONE]\n\n"));
    const g = createGenerationProvider({
      model: "mistral",
      baseUrl: server.url,
      apiKey: "k",
      maxTokens: 256,
      systemRole: "system",
    });
    await collect(g.generate(MESSAGES));
    const body = JSON.parse(server!.requests[0].body);
    expect(body).toMatchObject({
      model: "mistral",
      stream: true,
      temperature: 0.2,
      max_tokens: 256,
    });
    expect(body.messages).toEqual(MESSAGES); // system role kept
  });

  it('systemRole "merge" folds the system text into the first user message', async () => {
    server = await mockHttp(() => sseReply("data: [DONE]\n\n"));
    const g = createGenerationProvider({
      model: "m",
      baseUrl: server.url,
      maxTokens: 800,
      systemRole: "merge",
    });
    await collect(g.generate(MESSAGES));
    const body = JSON.parse(server!.requests[0].body);
    expect(body.messages).toEqual([
      { role: "user", content: "Antworte auf Deutsch.\n\nWas ist los in A.01?" },
    ]);
    expect(body.messages.some((m: ChatMessage) => m.role === "system")).toBe(false);
  });
});
