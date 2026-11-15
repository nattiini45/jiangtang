import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";

export const knownFixSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("edit"),
    id: z.string().min(1),
    title: z.string().trim().min(1),
    resolution: z.string().trim().min(1),
  }),
  z.object({ intent: z.literal("drop"), id: z.string().min(1) }),
]);

export async function editKnownFix(
  actor: AuditActor,
  roomId: string,
  input: z.infer<typeof knownFixSchema>,
) {
  return txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" = ${input.id} FOR UPDATE`;
    const current = await tx.ticket.findFirst({
      where: {
        id: input.id,
        roomId,
        status: "RESOLVED",
        type: { in: ["INCIDENT", "REPAIR"] },
        keepAsFix: true,
      },
    });
    if (!current) throw new NotFoundError(tr("work.err.ticket.notFound"));
    const ticket = await tx.ticket.update({
      where: { id: input.id },
      data:
        input.intent === "drop"
          ? { keepAsFix: false }
          : { title: input.title, resolution: input.resolution },
    });
    await audit({
      action: "TicketUpdated",
      entityType: "ticket",
      entityId: ticket.id,
      data: { knownFix: input.intent, keepAsFix: ticket.keepAsFix },
    });
    return ticket;
  });
}
