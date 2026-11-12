import { Form, useSubmit } from "react-router";
import { EventStatus } from "~/generated/prisma/enums";
import { calendarKinds, type CalendarChoice } from "~/lib/calendar-entries";
import { eventStatusLabel } from "~/components/events/labels";
import { Button, buttonVariants } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { useLocale, useT } from "~/i18n/use-t";

export function CalendarFilters({
  params,
  choices,
  rooms,
  equipment,
  mobile = false,
}: {
  params: URLSearchParams;
  choices: CalendarChoice[];
  rooms: { id: string; name: string }[];
  equipment: { id: string; label: string }[];
  mobile?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const submit = useSubmit();
  const kinds = calendarKinds(params, choices);
  return (
    <Form
      method="get"
      className="flex flex-wrap items-center gap-2"
      onChange={(event) => {
        const form = new FormData(event.currentTarget);
        const search = new URLSearchParams();
        for (const [key, value] of form)
          if (typeof value === "string" && key !== "kinds" && value) search.set(key, value);
        search.set("kinds", form.getAll("kinds").filter(Boolean).join(","));
        void submit(search, { method: "get", flushSync: true, preventScrollReset: true });
      }}
    >
      {!mobile ? <input type="hidden" name="view" value={params.get("view") ?? "week"} /> : null}
      <Input
        key={params.get("date")}
        type="date"
        name="date"
        defaultValue={params.get("date") ?? ""}
        aria-label={t("events.calendar.date")}
        className="w-40"
        min="1900-01-01"
        max="2100-12-31"
      />
      <Select
        name="status"
        aria-label={t("events.list.filterStatus")}
        value={params.get("status") ?? ""}
        onChange={() => {}}
        className="w-40"
      >
        <option value="">{t("events.list.allStatuses")}</option>
        {Object.values(EventStatus).map((status) => (
          <option key={status} value={status}>
            {eventStatusLabel(locale, status)}
          </option>
        ))}
      </Select>
      <Select
        name="room"
        aria-label={t("events.calendar.filterRoom")}
        value={params.get("room") ?? ""}
        onChange={() => {}}
        className="max-w-52"
      >
        <option value="">{t("events.calendar.allRooms")}</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </Select>
      <Select
        name="equipment"
        aria-label={t("events.calendar.filterEquipment")}
        value={params.get("equipment") ?? ""}
        onChange={() => {}}
        className="max-w-52"
      >
        <option value="">{t("events.calendar.allEquipment")}</option>
        {equipment.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </Select>
      <details className={mobile ? "relative w-full" : "relative"}>
        <summary className={`${buttonVariants({ variant: "tertiary" })} cursor-pointer list-none`}>
          {t("calendar.show", { count: kinds.length })}
        </summary>
        <fieldset
          className={`bg-popover text-popover-foreground shadow-surface-3 absolute z-40 mt-2 flex w-64 flex-col gap-1 rounded-lg p-2 ${mobile ? "left-0" : "right-0"}`}
        >
          <legend className="sr-only">{t("calendar.kinds")}</legend>
          <input type="hidden" name="kinds" value="" />
          {choices.map((choice) => (
            <label
              key={choice.id}
              className="hover:bg-hover flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
            >
              <Checkbox
                name="kinds"
                value={choice.id}
                checked={kinds.includes(choice.id)}
                onChange={() => {}}
              />
              {t(choice.label)}
            </label>
          ))}
        </fieldset>
      </details>
      <noscript>
        <Button type="submit" variant="tertiary">
          {t("events.list.filterSubmit")}
        </Button>
      </noscript>
    </Form>
  );
}
