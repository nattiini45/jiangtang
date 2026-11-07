/**
 * Browser side of the live-update stream, kept free of React and DOM globals so
 * it can be driven with fakes in tests. `use-live-refetch.ts` wires it to the
 * real `EventSource`, `fetch` and the React Router revalidator.
 *
 * A browser `EventSource` retries a dropped connection on its own, but gives up
 * for good once the server answers anything other than a 200 event stream (a
 * proxy 502 during a deploy, a 503, a 401). It reports both cases with the same
 * bare `error` event; only `readyState === CLOSED` tells them apart, and the
 * status code is never exposed. So after a fatal error this module asks the
 * server once with `probe`: a missing session stops reconnecting, anything else
 * rebuilds the stream after an exponential backoff.
 */

const EVENT_SOURCE_CLOSED = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export interface LiveEventSource {
  readonly readyState: number;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  close(): void;
}

/** `unauthorized` stops reconnecting; `retry` covers every other outcome, a failed request included. */
export type ProbeResult = "unauthorized" | "retry";

export interface LiveConnectionOptions {
  url: string;
  createEventSource: (url: string) => LiveEventSource;
  onRevalidate: () => void;
  /** Must give up when `signal` aborts; `probeStream` is the browser implementation. */
  probe: (url: string, signal: AbortSignal) => Promise<ProbeResult>;
  /** Injectable for tests; `Math.random` otherwise. */
  random?: () => number;
}

export interface LiveConnection {
  /** Skip a pending backoff and reconnect now, for example when the browser comes back online. */
  reconnectNow(): void;
  close(): void;
}

/**
 * Delay before reconnect attempt `attempt` (0-based): doubling from one second,
 * capped at thirty, with ±20% jitter so a restart does not bring every open tab
 * back in the same instant.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 16));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function connectLive(opts: LiveConnectionOptions): LiveConnection {
  const random = opts.random ?? Math.random;
  let source: LiveEventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  // Bumped whenever a reconnect cycle is superseded, so a late probe answer
  // from an earlier cycle cannot open a second stream.
  let cycle = 0;
  let probing: AbortController | null = null;

  const onChange = (): void => {
    opts.onRevalidate();
  };

  const onOpen = (): void => {
    attempt = 0;
    opts.onRevalidate();
  };

  const onError = (): void => {
    if (stopped || !source || source.readyState !== EVENT_SOURCE_CLOSED) return;
    teardownSource();
    const mine = ++cycle;
    const controller = new AbortController();
    probing = controller;
    void opts
      .probe(opts.url, controller.signal)
      .catch((): ProbeResult => "retry")
      .then((result) => {
        if (probing === controller) probing = null;
        if (stopped || mine !== cycle) return;
        if (result === "unauthorized") {
          stopped = true;
          return;
        }
        const delay = reconnectDelayMs(attempt, random);
        attempt += 1;
        timer = setTimeout(() => {
          timer = null;
          if (stopped || mine !== cycle) return;
          open();
        }, delay);
      });
  };

  function teardownSource(): void {
    if (!source) return;
    source.removeEventListener("open", onOpen);
    source.removeEventListener("change", onChange);
    source.removeEventListener("error", onError);
    source.close();
    source = null;
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function abortProbe(): void {
    probing?.abort();
    probing = null;
  }

  function open(): void {
    source = opts.createEventSource(opts.url);
    source.addEventListener("open", onOpen);
    source.addEventListener("change", onChange);
    source.addEventListener("error", onError);
  }

  open();

  return {
    reconnectNow(): void {
      if (stopped || source) return;
      cycle += 1;
      // A fresh network is a fresh start: a failure right after it backs off from one second.
      attempt = 0;
      clearTimer();
      abortProbe();
      open();
    },
    close(): void {
      stopped = true;
      cycle += 1;
      clearTimer();
      abortProbe();
      teardownSource();
    },
  };
}

/**
 * A 401 is answered at once, but a healthy stream may hold its headers until its
 * first write, so a probe that has not heard back within this long is treated
 * as a reachable, signed-in server.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Asks the stream endpoint for its status without keeping the stream: the
 * request is aborted once the headers arrive, after PROBE_TIMEOUT_MS, or when
 * `signal` aborts. 401 and 403 mean the session is gone, so reconnecting would
 * only hammer the server until the next sign-in.
 */
export async function probeStream(url: string, signal: AbortSignal): Promise<ProbeResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(onAbort, PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    return res.status === 401 || res.status === 403 ? "unauthorized" : "retry";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
