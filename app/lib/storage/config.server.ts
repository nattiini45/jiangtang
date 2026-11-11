import { resolve } from "node:path";

export function storageRoot() {
  return resolve(process.env.STORAGE_DIR ?? "./data/attachments");
}
