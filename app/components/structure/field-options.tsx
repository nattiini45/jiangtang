import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { action } from "~/routes/_desktop.admin.structure/route";
import type { fieldOptionsSchema } from "~/lib/custom-fields/definitions.schema";
import type { z } from "zod";
import { previewOptions } from "~/lib/custom-fields/admin";
import { useT } from "~/i18n/use-t";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { AdminField } from "./fields-tab";

export function FieldOptions({ field }: { field: AdminField }) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const pending = useRef<{
    kind: "add" | "paste";
    form?: HTMLFormElement;
    previous: typeof fetcher.data;
  } | null>(null);
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      !pending.current ||
      fetcher.data === pending.current.previous
    )
      return;
    if (fetcher.data.changed) {
      pending.current.form?.reset();
      if (pending.current.kind === "paste") {
        setPasting(false);
        setText("");
      }
    }
    pending.current = null;
  }, [fetcher.state, fetcher.data]);
  const rows = previewOptions(text, field.options);
  const additions = rows.filter((row) => row.status === "new");
  const submit = (changes: z.input<typeof fieldOptionsSchema>["changes"]) =>
    void fetcher.submit(
      {
        intent: "field",
        payload: JSON.stringify({ op: "options", input: { fieldId: field.id, changes } }),
      },
      { method: "post" },
    );
  const move = (index: number, direction: number) => {
    const options = [...field.options];
    [options[index], options[index + direction]] = [options[index + direction], options[index]];
    submit(options.map((option, position) => ({ op: "update", id: option.id, position })));
  };
  const nextPosition = Math.max(-1, ...field.options.map((option) => option.position)) + 1;
  return (
    <section
      className="border-border space-y-3 border-t pt-4"
      aria-label={t("fields.admin.options")}
    >
      <h3 className="text-sm font-semibold">
        {t("fields.admin.options")}{" "}
        <span className="text-muted-foreground nums font-normal">
          {field.options.filter((option) => !option.archivedAt).length}/50
        </span>
      </h3>
      <ol className="max-h-80 space-y-3 overflow-y-auto">
        {field.options.map((option, index) => (
          <li key={`${option.id}:${option.label}`} className="space-y-1" data-option-id={option.id}>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit([
                  {
                    op: "update",
                    id: option.id,
                    label: String(new FormData(event.currentTarget).get("label")),
                  },
                ]);
              }}
            >
              <Input
                aria-label={t("fields.admin.optionLabel")}
                name="label"
                defaultValue={option.label}
                maxLength={80}
                required
                className="min-w-0 flex-1"
              />
              <Button variant="secondary" disabled={busy}>
                {t("common.save")}
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("fields.admin.moveUp", { name: option.label })}
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-icon" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("fields.admin.moveDown", { name: option.label })}
                disabled={busy || index === field.options.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-icon" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  submit([{ op: "update", id: option.id, archived: !option.archivedAt }])
                }
              >
                {t(option.archivedAt ? "admin.structure.restore" : "admin.structure.archive")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("fields.admin.deleteOptionConfirm", { name: option.label })))
                    submit([{ op: "delete", id: option.id }]);
                }}
              >
                {t("common.delete")}
              </Button>
              {option.archivedAt ? (
                <span className="text-muted-foreground text-xs">
                  {t("admin.structure.archived")}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          pending.current = { kind: "add", form, previous: fetcher.data };
          submit([
            { op: "add", label: String(new FormData(form).get("label")), position: nextPosition },
          ]);
        }}
      >
        <Input
          name="label"
          disabled={busy}
          aria-label={t("fields.admin.newOption")}
          placeholder={t("fields.admin.newOption")}
          required
          maxLength={80}
          className="min-w-0 flex-1"
        />
        <Button
          variant="secondary"
          disabled={
            busy ||
            field.options.filter((option) => !option.archivedAt).length >= 50 ||
            field.options.length >= 200
          }
        >
          {t("fields.admin.addOption")}
        </Button>
      </form>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setPasting(!pasting);
          setPreview(false);
        }}
      >
        {t("fields.admin.paste")}
      </Button>
      {pasting ? (
        <div className="bg-tint space-y-3 rounded-md p-3">
          <label className="block text-sm">
            {t("fields.admin.pasteHelp")}
            <Textarea
              value={text}
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value);
                setPreview(false);
              }}
              rows={5}
              maxLength={18000}
            />
          </label>
          {!preview ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPreview(true)}
              disabled={!text.trim()}
            >
              {t("fields.admin.preview")}
            </Button>
          ) : (
            <>
              <ul
                className="max-h-48 space-y-1 overflow-y-auto"
                aria-label={t("fields.admin.preview")}
              >
                {rows.map((row, index) => (
                  <li key={index} className="flex gap-2 text-sm">
                    <span className="min-w-0 flex-1 wrap-anywhere">{row.label}</span>
                    <span
                      className={
                        row.status === "limit" || row.status === "invalid"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {t(`fields.admin.paste.${row.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                disabled={busy || !additions.length}
                onClick={() => {
                  pending.current = { kind: "paste", previous: fetcher.data };
                  submit(
                    additions.map((row, index) => ({
                      op: "add",
                      label: row.label,
                      position: nextPosition + index,
                    })),
                  );
                }}
              >
                {t("fields.admin.confirmPaste", { count: additions.length })}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {fetcher.data && !fetcher.data.changed ? (
        <p role="alert" className="text-destructive text-sm">
          {[...Object.values(fetcher.data.fieldErrors).flat(), ...fetcher.data.formErrors].join(
            " ",
          )}
        </p>
      ) : null}
    </section>
  );
}
