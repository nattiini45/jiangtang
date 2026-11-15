import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { backfillEquipmentKinds, initializeEquipmentKinds } from "./kinds.server";

export async function register(_app: Express, ctx: BootContext) {
  await initializeEquipmentKinds();
  let stopped = false;
  const handle = setImmediate(() => {
    if (!stopped)
      void backfillEquipmentKinds().catch((error: unknown) =>
        console.error("[equipment-kinds] backfill failed", error),
      );
  });
  handle.unref();
  ctx.onShutdown(() => {
    stopped = true;
    clearImmediate(handle);
  });
}
