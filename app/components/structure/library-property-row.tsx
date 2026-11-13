import { useFetcher } from "react-router";
import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, ChevronRight } from "lucide-react";
import type { action } from "~/routes/_desktop.admin.structure/route";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useT } from "~/i18n/use-t";
import type { AdminField } from "./fields-tab";

export function LibraryPropertyRow({
  field,
  kindId,
  first,
  last,
}: {
  field: AdminField;
  kindId: string;
  first: boolean;
  last: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const submit = (payload: unknown) =>
    void fetcher.submit({ intent: "field", payload: JSON.stringify(payload) }, { method: "post" });
  const update = (input: object) => submit({ op: "update", input: { id: field.id, ...input } });
  return (
    <li
      data-field-id={field.id}
      className="flex min-w-0 flex-wrap items-start gap-2 py-row text-sm"
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
          className="hover:bg-tint flex min-h-control w-full items-center gap-2 rounded-md text-left"
        >
          <ChevronRight className={`size-icon shrink-0 ${editing ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {field.name}
            {field.unit ? ` · ${field.unit}` : ""}
            {field.hidden ? (
              <span className="text-muted-foreground ml-2 text-xs">
                {t(`fields.level.${field.level}`)}
              </span>
            ) : null}
          </span>
        </button>
        {editing ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              update({ name: String(new FormData(event.currentTarget).get("name")) });
            }}
          >
            <label className="min-w-0 flex-1">
              {t("admin.structure.name")}
              <Input
                key={field.name}
                name="name"
                defaultValue={field.name}
                required
                maxLength={80}
                disabled={busy}
              />
            </label>
            <Button type="submit" variant="secondary" disabled={busy}>
              {t("common.save")}
            </Button>
            {field.renamed ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => update({ resetName: true })}
              >
                {t("fields.library.resetName")}
              </Button>
            ) : null}
          </form>
        ) : null}
      </div>
      {!field.hidden
        ? (["up", "down"] as const).map((direction) => (
            <Button
              key={direction}
              type="button"
              size="icon"
              variant="ghost"
              disabled={busy || (direction === "up" ? first : last)}
              aria-label={t(direction === "up" ? "fields.admin.moveUp" : "fields.admin.moveDown", {
                name: field.name,
              })}
              onClick={() =>
                submit({ op: "move", input: { id: field.id, kindId, direction, section: false } })
              }
            >
              {direction === "up" ? (
                <ArrowUp className="size-icon" />
              ) : (
                <ArrowDown className="size-icon" />
              )}
            </Button>
          ))
        : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={busy}
        aria-label={t(field.hidden ? "fields.library.show" : "fields.library.hide", {
          name: field.name,
        })}
        onClick={() => update({ archived: !field.hidden })}
      >
        {field.hidden ? <Eye className="size-icon" /> : <EyeOff className="size-icon" />}
      </Button>
      {fetcher.data && !fetcher.data.changed ? (
        <p role="alert" className="text-destructive basis-full text-sm">
          {[...Object.values(fetcher.data.fieldErrors).flat(), ...fetcher.data.formErrors].join(
            " ",
          )}
        </p>
      ) : null}
    </li>
  );
}
