import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { TicketType } from "~/generated/prisma/enums";
import { useLocale, useT } from "~/i18n/use-t";
import { ticketTypeLabel } from "./labels";
import type { TicketEquipmentOption, TicketRoomOption } from "./ticket-form-fields";

/**
 * quick-entry: "log an entry" fast. Room-first, then optionally equipment;
 * capture what/why (description) and optionally how (resolution). Posts the same
 * field names as ticketCreateSchema, so the action reuses createTicket. Reporter
 * defaults to the signed-in user; assignees are left for the full form.
 */
export function QuickEntryForm({
  rooms,
  equipment,
  defaults = {},
}: {
  rooms: TicketRoomOption[];
  equipment: TicketEquipmentOption[];
  defaults?: { roomId?: string | null; equipmentId?: string | null; type?: TicketType | null };
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="roomId" label={t("tickets.form.room")}>
          <Select name="roomId" defaultValue={defaults.roomId ?? ""}>
            <option value="">{t("tickets.form.noRoom")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          name="equipmentId"
          label={t("tickets.form.equipment")}
          hint={t("common.optional")}
        >
          <Select name="equipmentId" defaultValue={defaults.equipmentId ?? ""}>
            <option value="">{t("tickets.form.noEquipment")}</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <FormField name="type" label={t("tickets.form.type")}>
          <Select name="type" defaultValue={defaults.type ?? TicketType.INCIDENT}>
            {Object.values(TicketType).map((type) => (
              <option key={type} value={type}>
                {ticketTypeLabel(locale, type)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField name="title" label={t("tickets.form.title")}>
          <Input name="title" placeholder={t("tickets.quick.titlePlaceholder")} autoFocus />
        </FormField>
      </div>

      <FormField
        name="description"
        label={t("tickets.form.description")}
        hint={t("tickets.form.descriptionHint")}
      >
        <Textarea name="description" rows={3} />
      </FormField>

      <fieldset className="border-border flex flex-col gap-4 border p-3">
        <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
          {t("tickets.quick.statusLegend")}
        </legend>
        <FormField name="status" label={t("tickets.quick.statusQuestion")}>
          <Select name="status" defaultValue="OPEN">
            <option value="OPEN">{t("tickets.quick.statusOpen")}</option>
            <option value="RESOLVED">{t("tickets.quick.statusResolved")}</option>
          </Select>
        </FormField>
        <FormField
          name="resolution"
          label={t("tickets.form.resolution")}
          hint={t("tickets.quick.resolutionHint")}
        >
          <Textarea name="resolution" rows={2} />
        </FormField>
        <FormField
          name="occurredAt"
          label={t("tickets.form.occurredAt")}
          hint={t("tickets.quick.occurredAtHint")}
        >
          <Input type="date" name="occurredAt" />
        </FormField>
      </fieldset>
    </div>
  );
}
