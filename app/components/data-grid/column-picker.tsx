import { useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DEFAULT_COLUMNS,
  fieldColumnId,
  type ListColumns,
  type ListScope,
} from "~/lib/list-columns/columns";
import { useT } from "~/i18n/use-t";
import type { action } from "~/routes/list-columns/route";
import { resetWidths } from "./column-widths";

export function ColumnPicker({
  scope,
  config,
  builtins,
}: {
  scope: ListScope;
  config: ListColumns;
  builtins: { id: string; label: string }[];
}) {
  const t = useT();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        ref={trigger}
        type="button"
        variant="tertiary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Columns3 className="size-4" />
        {t("fields.columns.title")}
      </Button>
      {open ? (
        <section
          id={id}
          aria-label={t("fields.columns.title")}
          className="bg-card shadow-surface-3 absolute right-0 z-30 mt-2 w-[min(30rem,calc(100vw-18rem))] rounded-lg p-4"
        >
          <PickerForm
            key={JSON.stringify(config.columns)}
            scope={scope}
            config={config}
            builtins={builtins}
            close={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          />
        </section>
      ) : null}
    </div>
  );
}

function PickerForm({
  scope,
  config,
  builtins,
  close,
}: {
  scope: ListScope;
  config: ListColumns;
  builtins: { id: string; label: string }[];
  close: () => void;
}) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState(config.columns);
  const choices = [
    ...builtins.map((column) => ({ ...column, detail: "" })),
    ...config.fields.flatMap((field) =>
      field.type === "RANGE"
        ? []
        : [
            {
              id: fieldColumnId(field.id),
              label: field.name,
              detail: [
                t(`fields.type.${field.type}`),
                ...(scope === "EQUIPMENT"
                  ? [
                      field.kindNames.length
                        ? field.kindNames.join(", ")
                        : t("fields.columns.allKinds"),
                    ]
                  : []),
              ].join(" · "),
            },
          ],
    ),
  ];
  const ordered = [
    ...selected.flatMap((id) => choices.find((choice) => choice.id === id) ?? []),
    ...choices.filter((choice) => !selected.includes(choice.id)),
  ];
  const move = (index: number, direction: number) => {
    const next = [...selected];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setSelected(next);
  };
  return (
    <fetcher.Form
      method="post"
      action="/list-columns"
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="columns" value={JSON.stringify(selected)} />
      <div>
        <h2 className="font-semibold">{t("fields.columns.title")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("fields.columns.help", { count: selected.length })}
        </p>
      </div>
      <div className="max-h-[min(28rem,55vh)] overflow-y-auto">
        {ordered.map((choice) => {
          const index = selected.indexOf(choice.id);
          const checked = index !== -1;
          return (
            <div key={choice.id} className="flex items-center gap-2 border-b py-2 last:border-0">
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <Checkbox
                  checked={checked}
                  disabled={choice.id === "name" || (!checked && selected.length >= 12)}
                  onChange={() =>
                    setSelected(
                      checked
                        ? selected.filter((id) => id !== choice.id)
                        : [...selected, choice.id],
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block truncate" title={choice.label}>
                    {choice.label}
                  </span>
                  {choice.detail ? (
                    <span className="text-muted-foreground block text-xs [overflow-wrap:anywhere]">
                      {choice.detail}
                    </span>
                  ) : null}
                </span>
              </label>
              {checked && choice.id !== "name" ? (
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index <= 1}
                    aria-label={t("fields.columns.up", { name: choice.label })}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index === selected.length - 1}
                    aria-label={t("fields.columns.down", { name: choice.label })}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {fetcher.data?.error ? (
        <p role="alert" className="text-destructive text-sm">
          {t("fields.columns.invalid")}
        </p>
      ) : null}
      {fetcher.data?.saved ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("fields.columns.saved")}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => resetWidths()}>
          {t("common.dataGrid.resetWidths")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setSelected([...DEFAULT_COLUMNS[scope]])}
        >
          {t("fields.columns.reset")}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="tertiary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={fetcher.state !== "idle"}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </fetcher.Form>
  );
}
