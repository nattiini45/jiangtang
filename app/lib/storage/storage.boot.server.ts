import { resolve } from "node:path";
import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { setStorageProvider } from "./storage.server";
import { FsStorageProvider } from "./fs-provider";

/**
 * Installs the v1 encrypted-FS StorageProvider. Discovered by the
 * boot-loader; no Express routes to mount — upload/serve are React Router routes
 * (app/routes/attachments.*). Object root is STORAGE_DIR (default ./data/attachments,
 * which is gitignored).
 */
export function register(_app: Express, _ctx: BootContext): void {
  const root = resolve(process.env.STORAGE_DIR ?? "./data/attachments");
  setStorageProvider(new FsStorageProvider(root));
}
