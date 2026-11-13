import { useState } from "react";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Checkbox } from "~/components/ui/checkbox";
import { TicketStatus, TicketType } from "~/generated/prisma/enums";
import type { AssignableUser } from "~/domains/tickets/tickets.queries.server";
import { useLocale, useT } from "~/i18n/use-t";
import type { Locale } from "~/i18n/locales";
import type { Translate } from "~/i18n";
import { priorityOptions, ticketStatusLabel, ticketTypeLabel } from "./labels";

export interface TicketRoomOption {
  id: string;
  name: string;
}
export interface TicketEquipmentOption {
  id: string;
  label: string;
}

export interface TicketDefaults {
  type?: TicketType | null;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  roomId?: string | null;
  equipmentId?: string | null;
  eventId?: string | null;
  reporterId?: string | null;
  assigneeIds?: string[];
  occurredAt?: string; // YYYY-MM-DD
  // create-only:
  status?: string | null;
  resolution?: string | null;
  resolvedAt?: string; // YYYY-MM-DD
}

const CREATE_STATUSES: TicketStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED"];

function createStatusLabel(t: Translate, locale: Locale, status: TicketStatus): string {
  return status === "RESOLVED"
    ? t("tickets.form.createStatusResolved")
    : ticketStatusLabel(locale, status);
}

export function TicketFormFields({
  mode,
  rooms,
  equipment,
  users,
  defaults = {},
  functions,
}: {
  mode: "create" | "edit";
  rooms: TicketRoomOption[];
  equipment: TicketEquipmentOption[];
  users: AssignableUser[];
  defaults?: TicketDefaults;
  functions?: { roomId: string; functionId: string; name: string }[];
}) {
  const t = useT();
  const locale = useLocale();
  const [roomId, setRoomId] = useState(defaults.roomId ?? "");
  const [type, setType] = useState(defaults.type ?? TicketType.INCIDENT);
  const assigned = new Set(defaults.assigneeIds ?? []);

  return (
    <div className="flex flex-col gap-4">
      {/* No event picker yet; carry any existing/prefilled link
          through so an edit can't silently null it. */}
      <input type="hidden" name="eventId" defaultValue={defaults.eventId ?? ""} />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="type" label={t("tickets.form.type")}>
          <Select
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value as TicketType)}
          >
            {Object.values(TicketType).map((type) => (
              <option key={type} value={type}>
                {ticketTypeLabel(locale, type)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField name="priority" label={t("tickets.form.priority")} hint={t("common.optional")}>
          <Select
            name="priority"
            defaultValue={defaults.priority != null ? String(defaults.priority) : ""}
          >
            <option value="">—</option>
            {priorityOptions(locale).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <FormField name="title" label={t("tickets.form.title")}>
        <Input
          name="title"
          defaultValue={defaults.title ?? ""}
          placeholder={t("tickets.form.titlePlaceholder")}
          autoFocus
        />
      </FormField>

      <FormField
        name="description"
        label={t("tickets.form.description")}
        hint={t("tickets.form.descriptionHint")}
      >
        <Textarea name="description" defaultValue={defaults.description ?? ""} rows={4} />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="roomId" label={t("tickets.form.room")} hint={t("common.optional")}>
          <Select name="roomId" value={roomId} onChange={(event) => setRoomId(event.target.value)}>
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

      <div className="grid gap-4 sm:grid-cols-2">
        {functions && roomId && type === "INCIDENT" ? (
          <>
            <FormField
              name="functionId"
              label={t("functions.list.function")}
              hint={t("common.optional")}
            >
              <Select key={roomId} name="functionId" defaultValue="">
                <option value="">{t("functions.choose")}</option>
                {functions
                  .filter((entry) => entry.roomId === roomId)
                  .map((entry) => (
                    <option key={entry.functionId} value={entry.functionId}>
                      {entry.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <FormField name="impact" label={t("functions.impact")}>
              <Select name="impact" defaultValue="LIMITED">
                <option value="LIMITED">{t("functions.state.LIMITED")}</option>
                <option value="DOWN">{t("functions.state.DOWN")}</option>
              </Select>
            </FormField>
          </>
        ) : null}
        <FormField name="reporterId" label={t("tickets.form.reporter")} hint={t("common.optional")}>
          <Select name="reporterId" defaultValue={defaults.reporterId ?? ""}>
            <option value="">{t("tickets.form.noOne")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.initials ? ` (${u.initials})` : ""}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          name="occurredAt"
          label={t("tickets.form.occurredAt")}
          hint={t("tickets.form.occurredAtHint")}
        >
          <Input type="date" name="occurredAt" defaultValue={defaults.occurredAt ?? ""} />
        </FormField>
      </div>

      {users.length > 0 ? (
        <FormField name="assigneeIds" label={t("tickets.form.assignees")}>
          <div className="bg-card shadow-surface-2 grid gap-1.5 rounded-lg p-3 sm:grid-cols-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <Checkbox name="assigneeIds" value={u.id} defaultChecked={assigned.has(u.id)} />
                <span>
                  {u.name}
                  {u.initials ? (
                    <span className="text-muted-foreground text-xs"> {u.initials}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </FormField>
      ) : null}

      {mode === "create" ? (
        <fieldset className="bg-card shadow-surface-2 flex flex-col gap-4 rounded-lg p-4">
          <legend className="text-base font-semibold">
            {t("tickets.form.createStatusLegend")}
          </legend>
          <FormField
            name="status"
            label={t("tickets.form.status")}
            hint={t("tickets.form.createStatusHint")}
          >
            <Select name="status" defaultValue={defaults.status ?? "OPEN"}>
              {CREATE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {createStatusLabel(t, locale, s)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            name="resolution"
            label={t("tickets.form.resolution")}
            hint={t("tickets.form.resolutionHint")}
          >
            <Textarea name="resolution" defaultValue={defaults.resolution ?? ""} rows={3} />
          </FormField>
          <FormField
            name="resolvedAt"
            label={t("tickets.form.resolvedAt")}
            hint={t("tickets.form.resolvedAtHint")}
          >
            <Input type="date" name="resolvedAt" defaultValue={defaults.resolvedAt ?? ""} />
          </FormField>
        </fieldset>
      ) : null}
    </div>
  );
}
