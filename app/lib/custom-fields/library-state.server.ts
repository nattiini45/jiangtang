import type { Tx } from "~/lib/db.server";

export function recordLibraryStepInTx(tx: Tx, key: string, version: number) {
  return tx.libraryState.create({ data: { key, version } });
}
