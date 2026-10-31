/**
 * Shared OpenAI-compatible HTTP plumbing. One JSON POST helper plus the
 * streaming variant for chat completions:
 *
 * - `AbortSignal.timeout` per capability (embeddings 30 s, rerank 15 s,
 *   generation 120 s — set by the callers, not here);
 * - `Authorization: Bearer` is sent only when a key is configured — a keyless
 *   self-hosted endpoint is valid;
 * - one retry on 429/5xx with a short backoff;
 * - `AiProviderError` covers transport failures and unsuccessful HTTP
 *   responses and carries `status` + a truncated `bodyExcerpt`; JSON body
 *   decoding in `postJson` may throw and propagate unchanged. Constructed
 *   error messages do not interpolate the API key.
 */

import { tr } from "~/i18n/request-locale.server";

const BODY_EXCERPT = 500;
const RETRY_BACKOFF_MS = 400;

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly bodyExcerpt: string = "",
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

function headersFor(apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readExcerpt(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, BODY_EXCERPT);
}

export interface PostOptions {
  apiKey?: string;
  timeoutMs: number;
  body: unknown;
}

/** POST JSON, expect a JSON body back. One retry on 429/5xx. */
export async function postJson(url: string, opts: PostOptions): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headersFor(opts.apiKey),
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      // Timeout / connection failure — the retry contract covers HTTP statuses
      // only, so transport errors fail immediately but still surface typed.
      throw new AiProviderError(
        tr("places.err.ai.unreachable", { error: (e as Error).name }),
        null,
        "",
      );
    }
    if (res.ok) return res.json();
    const excerpt = await readExcerpt(res);
    if (isRetryable(res.status) && attempt === 0) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new AiProviderError(
      tr("places.err.ai.status", { status: res.status }),
      res.status,
      excerpt,
    );
  }
}

/** POST JSON, expect an SSE body back. The caller parses the stream. */
export async function postStream(url: string, opts: PostOptions): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headersFor(opts.apiKey), accept: "text/event-stream" },
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      throw new AiProviderError(
        tr("places.err.ai.unreachable", { error: (e as Error).name }),
        null,
        "",
      );
    }
    if (res.ok) {
      if (!res.body) throw new AiProviderError(tr("places.err.ai.noStream"), res.status, "");
      return res;
    }
    const excerpt = await readExcerpt(res);
    if (isRetryable(res.status) && attempt === 0) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new AiProviderError(
      tr("places.err.ai.status", { status: res.status }),
      res.status,
      excerpt,
    );
  }
}
