import { useId, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { ChevronDown } from "lucide-react";
import { useT } from "~/i18n/use-t";
import { fieldClassName } from "~/components/ui/input";
import { buttonVariants } from "~/components/ui/button";
import { useFieldError } from "~/components/forms";
import type {
  roomExpectationFields,
  listRoomTypes,
} from "~/domains/rooms/room-types.queries.server";

export function RoomTypeSelect({
  types,
  value,
  onValueChange,
  name = "roomTypeId",
  error,
}: {
  types: Awaited<ReturnType<typeof listRoomTypes>>;
  value: string | null;
  onValueChange: (value: string | null) => void;
  name?: string;
  error?: string;
}) {
  const t = useT();
  const errorId = useId();
  const items = [
    { value: "none", label: t("functions.types.none") },
    ...types.map((type) => ({ value: type.id, label: type.name })),
  ];
  return (
    <Select
      name={name}
      items={items}
      value={value ?? "none"}
      onValueChange={(value) => onValueChange(value === "none" ? null : value)}
    >
      <SelectLabel className="mb-1.5 block text-sm font-semibold">
        {t("functions.types.label")}
      </SelectLabel>
      <SelectTrigger
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={`${fieldClassName} h-control px-control flex w-full min-w-0 items-center justify-between gap-2 text-start`}
      >
        <SelectValue className="truncate" />
        <ChevronDown aria-hidden className="size-icon shrink-0" />
      </SelectTrigger>
      <SelectContent className="bg-popover text-popover-foreground shadow-surface-3 z-50 max-h-[min(24rem,var(--available-height))] min-w-(--anchor-width) max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg p-1">
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            className="data-highlighted:bg-muted cursor-pointer rounded-md px-3 py-2 text-sm [overflow-wrap:anywhere]"
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Select>
  );
}

export function RoomExpectationsFields({
  config,
  roomTypeId,
}: {
  config: Awaited<ReturnType<typeof roomExpectationFields>>;
  roomTypeId?: string | null;
}) {
  const t = useT();
  const typeError = useFieldError("roomTypeId");
  const expectationsError = useFieldError("expectations");
  const [typeId, setTypeId] = useState(roomTypeId ?? null);
  const [adjustments, setAdjustments] = useState<
    { functionId: string; expected: boolean | null; note?: string }[]
  >(config.expectations.map((row) => ({ ...row, note: row.note ?? "" })));
  const inherited = typeId
    ? (config.types.find((row) => row.id === typeId)?.functions.map((row) => row.functionId) ?? [])
    : config.servedIds;
  const expected = config.functions.filter(
    (fn) =>
      adjustments.find((row) => row.functionId === fn.id)?.expected ?? inherited.includes(fn.id),
  );
  const update = (functionId: string, patch: { expected?: boolean | null; note?: string }) =>
    setAdjustments((rows) => {
      const previous = rows.find((row) => row.functionId === functionId) ?? {
        functionId,
        expected: null,
      };
      return [...rows.filter((row) => row.functionId !== functionId), { ...previous, ...patch }];
    });
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2 text-base font-semibold">{t("functions.title")}</legend>
      <RoomTypeSelect
        types={config.types}
        value={typeId}
        onValueChange={setTypeId}
        error={typeError ?? expectationsError}
      />
      <p className="text-sm text-muted-foreground">{t("functions.types.help")}</p>
      <p className="text-sm [overflow-wrap:anywhere]">
        {t("functions.types.expects", {
          functions: expected.map((fn) => fn.name).join(", ") || "—",
        })}
      </p>
      <input type="hidden" name="expectations" value={JSON.stringify(adjustments)} />
      <Collapsible>
        <CollapsibleTrigger type="button" className={buttonVariants({ variant: "tertiary" })}>
          {t("functions.types.adjust")}
        </CollapsibleTrigger>
        <CollapsiblePanel className="divide-y">
          {config.functions.map((fn) => {
            const row = adjustments.find((row) => row.functionId === fn.id);
            const items = [
              { value: "inherit", label: t("functions.types.inherit") },
              { value: "yes", label: t("functions.types.expected") },
              { value: "no", label: t("functions.types.dropped") },
            ];
            return (
              <div key={fn.id} className="grid min-w-0 gap-3 py-3 sm:grid-cols-2">
                <Select
                  items={items}
                  value={row?.expected == null ? "inherit" : row.expected ? "yes" : "no"}
                  onValueChange={(value) =>
                    update(fn.id, { expected: value === "inherit" ? null : value === "yes" })
                  }
                >
                  <SelectLabel className="mb-1.5 block text-sm font-semibold">
                    {fn.name}
                  </SelectLabel>
                  <SelectTrigger
                    className={`${fieldClassName} h-control px-control flex w-full min-w-0 items-center justify-between gap-2 text-start`}
                  >
                    <SelectValue className="truncate" />
                    <ChevronDown aria-hidden className="size-icon shrink-0" />
                  </SelectTrigger>
                  <SelectContent className="bg-popover shadow-surface-3 z-50 min-w-(--anchor-width) rounded-lg p-1">
                    {items.map((item) => (
                      <SelectItem
                        key={item.value}
                        value={item.value}
                        className="data-highlighted:bg-muted rounded-md px-3 py-2 text-sm"
                      >
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {row?.expected != null ? (
                  <Field className="min-w-0">
                    <FieldLabel className="mb-1.5 block text-sm">
                      {t("functions.types.note", { function: fn.name })}
                    </FieldLabel>
                    <Input
                      className={`${fieldClassName} h-control px-control w-full`}
                      value={row.note ?? ""}
                      maxLength={1000}
                      onValueChange={(note) => update(fn.id, { note })}
                    />
                  </Field>
                ) : null}
              </div>
            );
          })}
        </CollapsiblePanel>
      </Collapsible>
    </fieldset>
  );
}
