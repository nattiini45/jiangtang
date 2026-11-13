import type { AuthUser } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { homeLayoutSchema, type HomeLayout } from "~/domains/dashboard/home-layout";

export async function saveOwnHomeLayout(actor: AuthUser, input: HomeLayout) {
  const layout = homeLayoutSchema.parse(input);
  await txWithAudit(actor, async (tx, audit) => {
    await tx.user.update({ where: { id: actor.id }, data: { homeLayout: layout } });
    await audit({ action: "HomeLayoutUpdated", entityType: "user", entityId: actor.id });
  });
  await emitChange({ entityType: "user", id: actor.id, op: "updated" });
}
