import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { createTicketInTx } from "~/domains/tickets/tickets.mutations.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";

export const moveKnownIssuesSchema = z.object({
  functionId: z.string().min(1),
  note: z.string().min(1),
});

export async function moveKnownIssues(
  actor: AuditActor,
  roomId: string,
  input: z.infer<typeof moveKnownIssuesSchema>,
) {
  return txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE`;
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundError(tr("err.room.notFound"));
    if (!room.knownIssues?.trim()) return null;
    if (room.knownIssues.replace(/\r\n/g, "\n") !== input.note.replace(/\r\n/g, "\n"))
      throw new ValidationError({}, [tr("functions.fixes.noteChanged")]);
    const ticket = await createTicketInTx(
      tx,
      audit,
      ticketCreateSchema.parse({
        type: "REPAIR",
        status: "RESOLVED",
        roomId,
        functionId: input.functionId,
        title: tr("functions.fixes.earlierNote"),
        resolution: room.knownIssues,
        keepAsFix: true,
        reporterId: actor.id ?? undefined,
      }),
    );
    await tx.room.update({ where: { id: roomId }, data: { knownIssues: null } });
    await audit({
      action: "RoomUpdated",
      entityType: "room",
      entityId: roomId,
      data: { knownIssuesMovedToTicketId: ticket.id, clearedFields: ["knownIssues"] },
    });
    return ticket;
  });
}
