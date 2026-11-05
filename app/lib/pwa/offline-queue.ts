import * as React from "react";
import { UNSAFE_decodeViaTurboStream, useRouteLoaderData } from "react-router";

/**
 * Offline capture queue — client module. When a mobile capture submit
 * fails because the network is down, the form fields are stored under a
 * client-generated id (`clientId`, also the future row's primary key — the
 * domain creates are idempotent on it) and replayed on the next `online`
 * event / shell mount.
 *
 * Storage is behind `OfflineQueueStore`: IndexedDB in the browser, an
 * in-memory implementation for unit tests — no new dependency.
 *
 * Every entry belongs to the person who was signed in when it was queued
 * (`userId`). A pass replays, and the UI lists and counts, only the current
 * user's entries; another user's stay stored, untouched, until that user
 * signs in on this device again. The owner also travels with every POST
 * (`CAPTURE_OWNER_HEADER`) and the capture actions answer 403 when it is not
 * the signed-in user: tabs share one cookie jar, so a tab that still shows the
 * previous user would otherwise replay their captures under the new session.
 * The 403 is read as the authentication wall, so the entry stays queued.
 *
 * An entry without an owner was queued before owners were recorded, by whoever
 * used the device then, and nobody can tell who that was. The first user whose
 * pass sees it adopts it and sends it under their own name. That keeps the
 * capture from being stranded, but if that user is not the person who wrote it,
 * they see it and it is created in their name; this is accepted for the few
 * entries that predate owners.
 *
 * Replay rules:
 *   2xx                    → remove (a retried create is deduped by clientId)
 *   authentication wall    → KEEP and stop the pass: a redirect to /login
 *                            (single-fetch 202 or a followed one), 401 or 403.
 *                            The captures are still unsent; they go out after
 *                            the next sign-in. Every remaining entry of that
 *                            user is flagged `authRequired`, not only the one
 *                            that met the wall: the flag describes the queue.
 *   4xx validation refusal → KEEP, with the server's error on the entry
 *   5xx / network error    → KEEP, retry on the next pass
 *   any other redirect     → KEEP, retry (not a confirmation, see postEntry)
 * The `authRequired` flag is cleared from all of the user's entries only by
 * evidence that the session works (an entry of the pass was sent, or the action
 * itself answered with a refusal) and no wall came after it; a network error, a
 * 5xx or an unconfirmed redirect says nothing about the session.
 *
 * Every POST targets the route's `.data` URL. A POST to the route *path* is a
 * document request: React Router runs the action and then renders the route
 * document, so the action's own payload never reaches `fetch`. Only `.data`
 * data requests return the action result — encoded with React Router's
 * single-fetch framing (`text/x-script`), which `readActionPayload` decodes.
 * The stored/visible `entry.url` stays the surface path; the queue UI filters
 * entries by it.
 */

export interface QueuedCapture {
  /** Dedupe key AND the entity's future id — cuid-shaped (`c` + hex). */
  clientId: string;
  /** POST target, e.g. `/m/tasks/new`. */
  url: string;
  fields: Record<string, string>;
  createdAt: number;
  /** Last refusal message (a 4xx the user must resolve or discard). */
  error?: string;
  /**
   * The last attempt hit the sign-in wall. Not a refusal: the entry is replayed
   * as usual, and the flag only tells the UI to ask for a new sign-in.
   */
  authRequired?: boolean;
  /**
   * Id of the user who queued the capture. Absent on entries queued before
   * owners were recorded (see the module comment for how those behave).
   */
  userId?: string;
}

export interface OfflineQueueStore {
  list(): Promise<QueuedCapture[]>;
  put(entry: QueuedCapture): Promise<void>;
  remove(clientId: string): Promise<void>;
}

/** In-memory store — unit tests and the non-DOM fallback. */
export class MemoryQueueStore implements OfflineQueueStore {
  private entries = new Map<string, QueuedCapture>();
  async list(): Promise<QueuedCapture[]> {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(entry: QueuedCapture): Promise<void> {
    this.entries.set(entry.clientId, entry);
  }
  async remove(clientId: string): Promise<void> {
    this.entries.delete(clientId);
  }
}

const DB_NAME = "jiangtang-offline";
const STORE = "captures";

/** IndexedDB store — one object store keyed by `clientId`. */
export class IdbQueueStore implements OfflineQueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "clientId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.db();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async list(): Promise<QueuedCapture[]> {
    const all = await this.run("readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(entry: QueuedCapture): Promise<void> {
    await this.run("readwrite", (s) => s.put(entry));
  }
  async remove(clientId: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(clientId));
  }
}

export function defaultStore(): OfflineQueueStore {
  return typeof indexedDB !== "undefined" ? new IdbQueueStore() : new MemoryQueueStore();
}

/**
 * The entries the given user may see, send and count: their own, plus those
 * without a recorded owner. Nothing is visible without a known user.
 */
export function visibleEntries(entries: QueuedCapture[], userId: string | undefined) {
  if (!userId) return [];
  return entries.filter((e) => e.userId === undefined || e.userId === userId);
}

/** `c` + 24 hex chars — matches the cuid shape the domains enforce. */
export function newClientId(): string {
  return `c${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Fired after every queue mutation so badges/lists can re-read the store. */
export const QUEUE_CHANGED_EVENT = "jiangtang:offline-queue-changed";

function notifyChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
  }
}

/** Header marking a queue/capture POST — capture actions answer it with JSON. */
export const CAPTURE_HEADER = "x-jiangtang-capture";

/**
 * Header naming the user a capture was queued by. The capture actions refuse
 * it (403) when it differs from the signed-in user, before writing anything.
 */
export const CAPTURE_OWNER_HEADER = "x-jiangtang-capture-owner";

export interface CaptureResult {
  state: "sent" | "queued" | "refused";
  /** Server refusal text when `state === "refused"`. */
  error?: string;
  clientId: string;
  /** The created row's id when the action answered JSON (`{ id }`). */
  id?: string;
  /**
   * With `state === "queued"`: the session has expired, so the capture waits on
   * the device until the person signs in again (not merely until online).
   */
  authRequired?: boolean;
}

/**
 * Submit a capture form now, or queue it when the network is down. `fields`
 * are the form's serialised fields; `clientId` is added by this function —
 * callers do not set it. `userId` is the signed-in user a queued entry is
 * bound to.
 */
export async function captureOrQueue(
  url: string,
  fields: Record<string, string>,
  store: OfflineQueueStore = defaultStore(),
  fetchImpl: typeof fetch = fetch,
  userId?: string,
): Promise<CaptureResult> {
  const clientId = newClientId();
  const entry: QueuedCapture = {
    clientId,
    url,
    fields,
    createdAt: Date.now(),
    ...(userId ? { userId } : {}),
  };
  const outcome = await postEntry(entry, fetchImpl);
  switch (outcome.kind) {
    case "sent":
      return { state: "sent", clientId, id: outcome.id };
    case "refused":
      return { state: "refused", error: outcome.error, clientId };
    case "auth":
      await store.put({ ...entry, authRequired: true });
      notifyChanged();
      return { state: "queued", clientId, authRequired: true };
    case "retry":
      await store.put(entry);
      notifyChanged();
      return { state: "queued", clientId };
  }
}

type PostOutcome =
  | { kind: "sent"; id?: string }
  | { kind: "refused"; error: string }
  | { kind: "auth" }
  | { kind: "retry" };

/** The capture action's own payload, as returned by a `.data` request. */
interface ActionPayload {
  id?: string;
  error?: string;
}

function asActionPayload(value: unknown): ActionPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { id?: unknown; error?: unknown };
  return {
    id: typeof v.id === "string" ? v.id : undefined,
    error: typeof v.error === "string" ? v.error : undefined,
  };
}

/**
 * Read the action payload from a response. `.data` requests answer with React
 * Router's single-fetch framing (`text/x-script` + turbo-stream), whose value
 * is `{ data: <action result> }`; a plain JSON response (unit tests, a
 * resource endpoint) is read as-is. Returns the raw text too, so a 4xx that is
 * not an action payload can still surface a bounded message.
 */
async function readActionPayload(
  res: Response,
): Promise<{ payload: ActionPayload | null; redirect: string | null; text: string }> {
  const text = await res.text().catch(() => "");
  if (!text) return { payload: null, redirect: null, text };
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/x-script")) {
    try {
      const decoded = await UNSAFE_decodeViaTurboStream(new Response(text).body!, globalThis);
      await decoded.done;
      // An action result is `{ data }`; a redirect thrown by the action is
      // `{ redirect, status, ... }` without that envelope.
      const envelope = decoded.value as { data?: unknown; redirect?: unknown } | null;
      const redirect = typeof envelope?.redirect === "string" ? envelope.redirect : null;
      return { payload: asActionPayload(envelope?.data), redirect, text };
    } catch {
      return { payload: null, redirect: null, text };
    }
  }
  try {
    return { payload: asActionPayload(JSON.parse(text)), redirect: null, text };
  } catch {
    return { payload: null, redirect: null, text };
  }
}

/** True for the sign-in page, whatever its query (`?next=`, `?deactivated=1`). */
function isLoginTarget(target: string): boolean {
  try {
    return /^\/login\/?$/.test(new URL(target, "http://localhost").pathname);
  } catch {
    return false;
  }
}

/**
 * React Router answers a redirect to a `.data` request with HTTP 202 and a
 * turbo-stream body instead of a 3xx, so `res.ok` is true for it. Single fetch
 * uses 202 for nothing else, which is why an undecodable 202 is treated as a
 * redirect nobody could confirm.
 */
const SINGLE_FETCH_REDIRECT_STATUS = 202;

async function postEntry(entry: QueuedCapture, fetchImpl: typeof fetch): Promise<PostOutcome> {
  try {
    const body = new URLSearchParams({ ...entry.fields, clientId: entry.clientId });
    // A POST to the route path renders the document; `.data` is the data
    // request that carries the action's result back to `fetch`.
    const dataUrl = entry.url.endsWith(".data") ? entry.url : `${entry.url}.data`;
    const res = await fetchImpl(dataUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        [CAPTURE_HEADER]: "1",
        ...(entry.userId ? { [CAPTURE_OWNER_HEADER]: entry.userId } : {}),
      },
      body,
    });
    // An expired session surfaces as a redirect to /login (requireUser): either
    // as the 202 single-fetch redirect, or as a redirect fetch followed itself.
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    if (res.redirected && isLoginTarget(res.url)) return { kind: "auth" };
    if (res.status === SINGLE_FETCH_REDIRECT_STATUS) {
      const { redirect } = await readActionPayload(res);
      if (redirect !== null && isLoginTarget(redirect)) return { kind: "auth" };
      // A capture action answers `{ id }` on success and never redirects, so
      // any other redirect confirms nothing. Keep the entry: the create is
      // idempotent on clientId, so replaying a row that exists is harmless,
      // while dropping it could lose the capture.
      return { kind: "retry" };
    }
    // Likewise a followed redirect to a page other than /login.
    if (res.redirected) return { kind: "retry" };
    if (res.ok) {
      // Capture actions answer the header with `{ id }` — the page needs it to
      // navigate to the new row; a non-JSON 2xx simply counts as sent.
      const { payload } = await readActionPayload(res);
      return { kind: "sent", id: payload?.id };
    }
    if (res.status >= 400 && res.status < 500) {
      const { payload, text } = await readActionPayload(res);
      let error = payload?.error ?? `HTTP ${res.status}`;
      if (!payload?.error) {
        const bounded = text.slice(0, 300);
        if (bounded) error = bounded;
      }
      return { kind: "refused", error };
    }
    return { kind: "retry" };
  } catch {
    // TypeError = network down; anything else is equally retryable.
    return { kind: "retry" };
  }
}

/**
 * Replay the queued captures of `userId` in creation order (every entry when
 * no user is given). 2xx → remove; 4xx → keep with the server's error stored
 * on the entry; 5xx/network → keep. An authentication wall keeps the entry,
 * flags it and every other waiting entry of the user `authRequired`, and ends
 * the pass (`authRequired: true` in the result): the remaining entries would
 * meet the same wall, and the next pass runs after the person signs in again.
 * Other users' entries are not touched.
 *
 * Both the mobile shell badge and a capture page mount `useOfflineQueue`, so
 * two replays can start in the same tick. They share one in-flight pass:
 * without this, the same entry is POSTed twice and the create races itself.
 * A pass for another user waits for the running one instead of joining it,
 * because signing out and in again does not reload the page.
 */
export function replayQueue(
  store: OfflineQueueStore = defaultStore(),
  fetchImpl: typeof fetch = fetch,
  userId?: string,
): Promise<ReplaySummary> {
  if (replayInFlight && replayInFlight.userId === userId) return replayInFlight.promise;
  const previous = replayInFlight?.promise.catch(() => undefined);
  const run = () => replayQueueOnce(store, fetchImpl, userId);
  const promise = (previous ? previous.then(run) : run()).finally(() => {
    if (replayInFlight?.promise === promise) replayInFlight = null;
  });
  replayInFlight = { userId, promise };
  return promise;
}

export interface ReplaySummary {
  sent: number;
  refused: number;
  kept: number;
  /** Present (true) only when the pass stopped at an authentication wall. */
  authRequired?: boolean;
}

let replayInFlight: { userId: string | undefined; promise: Promise<ReplaySummary> } | null = null;

async function replayQueueOnce(
  store: OfflineQueueStore,
  fetchImpl: typeof fetch,
  userId: string | undefined,
): Promise<ReplaySummary> {
  let sent = 0;
  let refused = 0;
  let kept = 0;
  let authRequired = false;
  let changed = false;
  const entries: QueuedCapture[] = [];
  for (const stored of await store.list()) {
    if (userId === undefined || stored.userId === userId) {
      entries.push(stored);
    } else if (stored.userId === undefined) {
      const adopted = { ...stored, userId };
      await store.put(adopted);
      entries.push(adopted);
      changed = true;
    }
  }
  // The pass's entries that are still stored when it ends, in queue order.
  const remaining: QueuedCapture[] = [];
  for (const [index, entry] of entries.entries()) {
    // A 4xx-refused entry waits for the user (discard or fix); replaying it on
    // every pass only repeats the same refusal. It stays visible with its error.
    if (entry.error) {
      kept += 1;
      remaining.push(entry);
      continue;
    }
    const outcome = await postEntry(entry, fetchImpl);
    if (outcome.kind === "sent") {
      await store.remove(entry.clientId);
      sent += 1;
      changed = true;
    } else if (outcome.kind === "refused") {
      // The action itself answered, so any sign-in notice on the entry is stale.
      const { authRequired: _stale, ...rest } = entry;
      const refusedEntry = { ...rest, error: outcome.error };
      await store.put(refusedEntry);
      remaining.push(refusedEntry);
      refused += 1;
      changed = true;
    } else if (outcome.kind === "auth") {
      authRequired = true;
      // The rest of the queue would meet the same wall.
      kept += entries.length - index;
      remaining.push(...entries.slice(index));
      break;
    } else {
      // Inconclusive about the session, so the sign-in flag stays as it is.
      kept += 1;
      remaining.push(entry);
    }
  }
  // The flag describes the queue behind the wall, not one entry: a wall flags
  // everything still waiting, and proof that the session works (a send, or the
  // action's own refusal) clears it from all of the user's entries.
  const flag = authRequired ? true : sent + refused > 0 ? false : null;
  if (flag !== null) {
    for (const entry of remaining) {
      if (flag) {
        // A refused entry waits for the user, not for a sign-in.
        if (entry.authRequired || entry.error) continue;
        await store.put({ ...entry, authRequired: true });
      } else {
        if (!entry.authRequired) continue;
        const { authRequired: _stale, ...rest } = entry;
        await store.put(rest);
      }
      changed = true;
    }
  }
  if (changed) notifyChanged();
  return authRequired ? { sent, refused, kept, authRequired } : { sent, refused, kept };
}

/**
 * The signed-in user's id, from the /m layout loader. Queued captures are bound
 * to it. `undefined` outside that layout, where nothing is listed or replayed.
 */
export function useQueueOwner(): string | undefined {
  const data = useRouteLoaderData("routes/m") as { user?: { id?: unknown } } | undefined;
  return typeof data?.user?.id === "string" ? data.user.id : undefined;
}

/**
 * React side of the queue: the pending count for the shell badge, the entry
 * list for capture pages (refused entries show their error + a discard
 * button), and the two replay triggers — the `online` event and mount. Only the
 * signed-in user's entries are listed, counted and replayed; `authRequired`
 * covers all of them, not just one page's.
 * No-op during SSR (`defaultStore` falls back to memory there).
 */
export function useOfflineQueue(storeOverride?: OfflineQueueStore) {
  // `defaultStore()` must not be a default parameter — a fresh instance every
  // render would retrigger the effect deps below on each state update.
  const store = React.useMemo(() => storeOverride ?? defaultStore(), [storeOverride]);
  const userId = useQueueOwner();
  // The stored list as read, unfiltered: the user can change without a remount
  // (another tab signs out and in), and a read that started for the previous
  // user must not decide what the new one sees. Filtering happens at render.
  const [raw, setRaw] = React.useState<QueuedCapture[]>([]);
  const latestRead = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const read = ++latestRead.current;
    const list = await store.list();
    // A newer read is already in flight or done; its result is the fresher one.
    if (read === latestRead.current) setRaw(list);
  }, [store]);

  const discard = React.useCallback(
    async (clientId: string) => {
      await store.remove(clientId);
      notifyChanged();
      await refresh();
    },
    [store, refresh],
  );

  React.useEffect(() => {
    void refresh();
    const replay = () => {
      if (userId) void replayQueue(store, fetch, userId).then(refresh);
    };
    replay();
    const onChanged = () => void refresh();
    window.addEventListener("online", replay);
    window.addEventListener(QUEUE_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("online", replay);
      window.removeEventListener(QUEUE_CHANGED_EVENT, onChanged);
    };
  }, [store, userId, refresh]);

  const entries = React.useMemo(() => visibleEntries(raw, userId), [raw, userId]);
  const authRequired = entries.some((e) => e.authRequired);

  return { entries, pending: entries.length, authRequired, discard, refresh };
}
