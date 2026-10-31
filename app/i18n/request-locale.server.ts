import { AsyncLocalStorage } from "node:async_hooks";
import { t, type MessageKey, type MessageParams } from "./index";
import type { Locale } from "./locales";
import { workspaceLocale } from "./locale.server";

/*
 * Domain functions, zod schemas and storage code are called from many places
 * and never see the HTTP request. The request's locale travels beside the call
 * instead of through every signature: the locale middleware (`locale.boot.server.ts`)
 * opens a scope per request, `tr()` reads it. Outside a scope (tests, scripts,
 * background jobs) it falls back to the workspace locale. Keyed on a global
 * symbol so a duplicated module instance (dev HMR) still shares one store.
 */
const STORE_KEY = Symbol.for("jiangtang.requestLocale");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: AsyncLocalStorage<Locale> };
const g = globalThis as GlobalWithStore;
const storage = (g[STORE_KEY] ??= new AsyncLocalStorage<Locale>());

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return storage.run(locale, fn);
}

/** The locale of the request being handled, else `DEFAULT_LOCALE`. */
export function currentLocale(): Locale {
  return storage.getStore() ?? workspaceLocale();
}

/** Translate into the current request's locale. For server code that has no `Request` at hand. */
export function tr(key: MessageKey, params?: MessageParams): string {
  return t(currentLocale(), key, params);
}
