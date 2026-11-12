import { z } from "zod";
import { ValidationError } from "~/lib/errors.server";
import { localizeMessage } from "~/i18n";
import { currentLocale, tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { applies, fieldGroups } from "./fields";
import { getDefinitions, lockDefinitions } from "./definitions.server";
import { createFieldSchema, updateFieldSchema, fieldOptionsSchema } from "./definitions.schema";

export const fieldMoveSchema = z.object({
  id: z.string().min(1),
  direction: z.enum(["up", "down"]),
  section: z.boolean(),
  kindId: z.string().optional(),
  showArchived: z.boolean().default(false),
});

export const fieldAdminSchema = z.object({
  intent: z.literal("field"),
  payload: z.string().transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "err.validationFailed" });
      return z.NEVER;
    }
  }),
});
const fieldAdminPayload = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), input: createFieldSchema.omit({ key: true }) }),
  z.object({ op: z.literal("update"), input: updateFieldSchema }),
  z.object({ op: z.literal("move"), input: fieldMoveSchema }),
  z.object({ op: z.literal("options"), input: fieldOptionsSchema }),
  z.object({ op: z.literal("delete"), id: z.string().min(1), confirm: z.literal(true) }),
]);

export function parseFieldAdminPayload(payload: unknown) {
  const result = fieldAdminPayload.safeParse(payload);
  if (result.success) return result.data;
  const errors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] === "input" ? (issue.path[1] ?? "payload") : "payload");
    const message = issue.message.startsWith("fields.")
      ? localizeMessage(currentLocale(), issue.message)
      : tr("err.validationFailed");
    (errors[key] ??= []).push(message);
  }
  throw new ValidationError(errors);
}

export async function moveCustomField(actor: AuditActor, input: z.input<typeof fieldMoveSchema>) {
  const { id, direction, section, kindId, showArchived } = fieldMoveSchema.parse(input);
  await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const field = await tx.customField.findUniqueOrThrow({ where: { id } });
    const all = await getDefinitions(field.scope, tx);
    const visible = (row: (typeof all)[number]) =>
      (showArchived || !row.archivedAt) && (field.scope === "ROOM" || applies(row, kindId));
    const shown = all.filter(visible);
    const groups = fieldGroups(shown);
    const groupIndex = groups.findIndex((group) => group.fields.some((row) => row.id === id));
    if (groupIndex === -1) return;
    let ordered = all;
    if (section) {
      const target = groupIndex + (direction === "up" ? -1 : 1);
      if (target < 0 || target >= groups.length) return;
      [groups[groupIndex], groups[target]] = [groups[target], groups[groupIndex]];
      const complete = fieldGroups(all);
      const bySection = new Map(complete.map((group) => [group.section, group]));
      let index = 0;
      ordered = complete.flatMap((group) =>
        group.fields.some(visible) ? bySection.get(groups[index++].section)!.fields : group.fields,
      );
    } else {
      const rows = groups[groupIndex].fields;
      const index = rows.findIndex((row) => row.id === id);
      const target = index + (direction === "up" ? -1 : 1);
      if (target < 0 || target >= rows.length) return;
      const first = all.findIndex((row) => row.id === id);
      const second = all.findIndex((row) => row.id === rows[target].id);
      [ordered[first], ordered[second]] = [ordered[second], ordered[first]];
    }
    for (const [position, row] of ordered.entries())
      await tx.customField.update({ where: { id: row.id }, data: { position } });
    await audit({
      action: "CustomFieldUpdated",
      entityType: "customField",
      entityId: id,
      data: { order: ordered.map((row) => row.id), section, direction },
    });
  });
  await emitChange({ entityType: "customField", id, op: "updated" });
}
