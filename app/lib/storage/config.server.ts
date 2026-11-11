import { resolve } from "node:path";
import { readConfig } from "~/lib/config.server";

export function storageRoot() {
  return resolve(readConfig("STORAGE_DIR"));
}
