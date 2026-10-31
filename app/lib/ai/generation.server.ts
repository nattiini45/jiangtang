/**
 * `api`-tier GenerationProvider: OpenAI-compatible
 * `POST {base}/chat/completions` with `stream: true`.
 *
 * SSE handling is deliberately manual: events may split across HTTP chunks, a
 * `data:` payload may span multiple lines, keep-alive comments (`:` lines) are
 * skipped, and `data: [DONE]` ends the stream. Only `choices[0].delta.content`
 * strings are yielded.
 *
 * `GENERATION_SYSTEM_ROLE=merge` prepends the system text to the first user
 * message instead of sending a `system` role — older Mistral-Instruct chat
 * templates reject one.
 */
import { AiProviderError, postStream } from "./openai-compat.server";
import type { GenerationConfig } from "./config.server";
import type { ChatMessage, GenerationProvider } from "./types";

const TIMEOUT_MS = 120_000;

/** system-role rewrite — "system" passes through, "merge" folds the system
 *  text(s) into the first user message so no `system` role is sent. */
function applySystemRole(
  messages: ChatMessage[],
  mode: GenerationConfig["systemRole"],
): ChatMessage[] {
  if (mode === "system") return messages;
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n");
  if (!systemText) return messages.filter((m) => m.role !== "system");
  const rest = messages.filter((m) => m.role !== "system");
  const firstUser = rest.findIndex((m) => m.role === "user");
  if (firstUser === -1) return rest;
  return rest.map((m, i) =>
    i === firstUser ? { ...m, content: `${systemText}\n\n${m.content}` } : m,
  );
}

/** One SSE event = a blank-line-separated block; we collect `data:` payloads. */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const crlf = buffer.indexOf("\r\n\r\n");
        const lf = buffer.indexOf("\n\n");
        let sep = -1;
        let sepLen = 0;
        if (lf !== -1 && (crlf === -1 || lf < crlf)) {
          sep = lf;
          sepLen = 2;
        } else if (crlf !== -1) {
          sep = crlf;
          sepLen = 4;
        } else break;
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + sepLen);
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          // `:`-prefixed comments / keep-alives and event:/id:/retry: are ignored.
        }
        if (dataLines.length) yield dataLines.join("\n");
      }
    }
    // Flush a trailing event without a blank-line terminator.
    const tail = buffer.trim();
    if (tail) {
      for (const line of tail.split(/\r?\n/)) {
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createGenerationProvider(cfg: GenerationConfig): GenerationProvider {
  return {
    id: `${cfg.model}@api`,
    async *generate(messages) {
      const res = await postStream(`${cfg.baseUrl}/chat/completions`, {
        apiKey: cfg.apiKey,
        timeoutMs: TIMEOUT_MS,
        body: {
          model: cfg.model,
          messages: applySystemRole(messages, cfg.systemRole),
          stream: true,
          temperature: 0.2,
          max_tokens: cfg.maxTokens,
        },
      });
      for await (const payload of sseDataLines(res.body!)) {
        if (payload === "[DONE]") return;
        let parsed: { choices?: Array<{ delta?: { content?: unknown } }> };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // a partial/keep-alive payload must not kill the stream
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) yield delta;
      }
    },
  };
}

export { AiProviderError };
