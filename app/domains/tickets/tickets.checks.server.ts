import type { Tx } from "~/lib/db.server";
import type { AuditFn } from "~/lib/audit.server";
import type { TicketCreateInput } from "./tickets.schema";
import { createTicketInTx } from "./tickets.mutations.server";

export async function recordFunctionFaultInTx(
  tx: Tx,
  audit: AuditFn,
  input: TicketCreateInput & {
    roomId: string;
    functionId: string;
    impact: "DOWN" | "LIMITED";
  },
) {
  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Ticket" WHERE "roomId" = ${input.roomId} AND "functionId" = ${input.functionId}
      AND type = 'INCIDENT' AND status IN ('OPEN', 'IN_PROGRESS')
    ORDER BY "occurredAt", id LIMIT 1 FOR UPDATE`;
  if (!existing.length) return createTicketInTx(tx, audit, input);
  const current = await tx.ticket.findUniqueOrThrow({ where: { id: existing[0].id } });
  const fault = await tx.ticket.update({
    where: { id: current.id },
    data: {
      impact: current.impact === "DOWN" || input.impact === "DOWN" ? "DOWN" : "LIMITED",
      description: input.description
        ? [current.description, input.description].filter(Boolean).join("\n\n")
        : current.description,
    },
  });
  await audit({
    action: "TicketUpdated",
    entityType: "ticket",
    entityId: fault.id,
    data: { viaCheck: true, impact: fault.impact },
  });
  return fault;
}
