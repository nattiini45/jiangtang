import { Prisma } from "~/generated/prisma/client";
import type { Tx } from "~/lib/db.server";

export async function queueEquipmentReindex(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const values = Prisma.join(
    ids.map(
      (id) =>
        Prisma.sql`(gen_random_uuid()::text, 'EQUIPMENT', ${id}, 'reindex', now(), now(), now())`,
    ),
  );
  await tx.$executeRaw`INSERT INTO "SearchIndexJob" (id, "sourceType", "sourceId", op, "nextAttemptAt", "createdAt", "updatedAt") VALUES ${values} ON CONFLICT ("sourceType", "sourceId", op) DO UPDATE SET "updatedAt" = clock_timestamp(), "nextAttemptAt" = now()`;
}
