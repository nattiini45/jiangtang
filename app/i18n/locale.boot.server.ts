import type { Express } from "express";
import { resolveLocaleFromHeaders } from "./locale.server";
import { runWithLocale } from "./request-locale.server";

/** Middleware, so it must precede every route-registering boot module. */
export const order = -20;

/**
 * Opens the per-request locale scope that `tr()` reads, so validation and
 * domain errors thrown deep in a loader/action come out in the visitor's language.
 */
export function register(app: Express): void {
  app.use((req, _res, next) => {
    runWithLocale(
      resolveLocaleFromHeaders(req.headers.cookie, req.headers["accept-language"]),
      next,
    );
  });
}
