import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useFieldError } from "~/components/forms";
import { Label } from "~/components/ui/label";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { FieldValue } from "./field-values";
import { useT } from "~/i18n/use-t";
import {
  applies,
  fieldGroups,
  inputValue,
  postedValue,
  sameValue,
  valueObject,
  type Field,
  type FilledField,
} from "~/lib/custom-fields/fields";

export function FieldInputs(props: {
  fields: Field[];
  stored?: unknown;
  kindId?: string;
  modelId?: string | null;
  modelValues?: unknown;
}) {
  const t = useT();
  const applicable = props.fields.filter(
    (field) => field.type !== "RANGE" && applies(field, props.kindId),
  );
  const hidden = props.fields.filter(
    (field) =>
      !applies(field, props.kindId) && !sameValue(valueObject(props.stored)[field.id], null),
  ).length;
  const essential = applicable.filter(
    (field) => field.origin !== "library" || field.weight === "must",
  );
  const other = applicable.filter((field) => field.origin === "library" && field.weight !== "must");
  return (
    <>
      {hidden > 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("fields.form.hidden", { count: hidden })}
        </p>
      ) : null}
      <FieldEditor {...props} fields={essential} />
      {other.length ? (
        <details className="min-w-0">
          <summary className="cursor-pointer py-2 text-sm font-semibold">
            {t("fields.properties.more", { count: other.length })}
          </summary>
          <FieldEditor {...props} fields={other} />
        </details>
      ) : null}
    </>
  );
}

function FieldEditor({
  fields,
  stored,
  kindId,
  modelId,
  modelValues,
}: {
  fields: Field[];
  stored?: unknown;
  kindId?: string;
  modelId?: string | null;
  modelValues?: unknown;
}) {
  const t = useT();
  const valuesError = useFieldError("customValues");
  const before = valueObject(stored);
  const [draft, setDraft] = useState<Record<string, string | string[]>>({});
  useEffect(() => {
    setDraft((current) => {
      const pending = Object.fromEntries(
        Object.entries(current).filter(([id, value]) => {
          const field = fields.find((field) => field.id === id);
          return !field || !sameValue(postedValue(field, value), valueObject(stored)[id]);
        }),
      );
      return Object.keys(pending).length === Object.keys(current).length ? current : pending;
    });
  }, [fields, stored]);
  const applicable = fields.filter((field) => applies(field, kindId));
  const hidden = fields.filter(
    (field) => !applies(field, kindId) && !sameValue(before[field.id], null),
  ).length;
  return (
    <>
      {valuesError ? (
        <p role="alert" className="text-destructive text-sm">
          {valuesError}
        </p>
      ) : null}
      {hidden > 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("fields.form.hidden", { count: hidden })}
        </p>
      ) : null}
      {fieldGroups(applicable).map(({ section, fields }) => (
        <fieldset key={section} className="border-border min-w-0 rounded-lg border p-4">
          <legend className="max-w-full px-1 text-base font-semibold [overflow-wrap:anywhere]">
            {section || t("fields.moreDetails")}
          </legend>
          <div className="grid gap-4 lg:grid-cols-2">
            {fields.map((field) => {
              if (modelId && field.level === "MODEL") {
                const value = valueObject(modelValues)[field.id] ?? before[field.id];
                const label = (id: unknown) =>
                  field.options.find((option) => option.id === id)?.label ?? String(id);
                const display =
                  field.type === "CHOICE"
                    ? label(value)
                    : field.type === "MULTI_CHOICE" && Array.isArray(value)
                      ? value.map(label)
                      : value;
                return (
                  <div key={field.id} className="min-w-0 text-sm">
                    <div className="font-semibold [overflow-wrap:anywhere]">{field.name}</div>
                    <div className="my-1 [overflow-wrap:anywhere]">
                      {value == null ? (
                        t("fields.form.unset")
                      ) : (
                        <FieldValue field={{ ...field, value: display as FilledField["value"] }} />
                      )}
                    </div>
                    {modelId.startsWith("catalog:") ? (
                      <p className="text-muted-foreground text-xs">
                        {t("inventory.catalog.onSave")}
                      </p>
                    ) : (
                      <Link
                        to={`/inventory/models/${modelId}`}
                        className="text-muted-foreground text-xs underline underline-offset-4"
                      >
                        {t("fields.model.edit")}
                      </Link>
                    )}
                  </div>
                );
              }
              const value = draft[field.id] ?? inputValue(field, before[field.id]);
              const changed =
                !sameValue(value, inputValue(field, before[field.id])) &&
                !sameValue(postedValue(field, value), before[field.id]);
              return (
                <div
                  key={field.id}
                  className={field.type === "LONG_TEXT" ? "min-w-0 lg:col-span-2" : "min-w-0"}
                >
                  {changed
                    ? (Array.isArray(value) && value.length
                        ? value
                        : [Array.isArray(value) ? "" : value]
                      ).map((entry, index) => (
                        <input key={index} type="hidden" name={`cf.${field.id}`} value={entry} />
                      ))
                    : null}
                  <FieldControl
                    field={field}
                    value={value}
                    onChange={(value) =>
                      setDraft((draft) => {
                        const next = { ...draft };
                        if (
                          sameValue(value, inputValue(field, before[field.id])) ||
                          sameValue(postedValue(field, value), before[field.id])
                        )
                          delete next[field.id];
                        else next[field.id] = value;
                        return next;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}) {
  const t = useT();
  const name = `cf.${field.id}`;
  const error = useFieldError(name);
  const props = {
    id: name,
    "aria-invalid": !!error,
    "aria-describedby":
      [field.helpText ? `${name}.help` : null, error ? `${name}.error` : null]
        .filter(Boolean)
        .join(" ") || undefined,
    value: String(value),
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => onChange(event.currentTarget.value),
  };
  const options = field.options.filter(
    (option) =>
      !option.archived || (Array.isArray(value) ? value.includes(option.id) : value === option.id),
  );
  const help = field.helpText ? (
    <p id={`${name}.help`} className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
      {field.helpText}
    </p>
  ) : null;
  if (field.type === "MULTI_CHOICE")
    return (
      <fieldset
        className="flex min-w-0 flex-col gap-1.5"
        aria-describedby={props["aria-describedby"]}
        aria-invalid={!!error}
      >
        <legend className="mb-1.5 text-sm font-medium [overflow-wrap:anywhere]">
          {field.name}
        </legend>
        {help}
        <MultipleChoice
          field={field}
          options={options}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
        {error ? (
          <p id={`${name}.error`} role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </fieldset>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={name} className="[overflow-wrap:anywhere]">
        {field.name}
      </Label>
      <div className="flex min-w-0 flex-col gap-1.5">
        {help}
        {field.type === "LONG_TEXT" ? (
          <Textarea {...props} rows={3} />
        ) : field.type === "BOOLEAN" || field.type === "CHOICE" ? (
          <Select {...props}>
            <option value="">{t("fields.form.unset")}</option>
            {field.type === "BOOLEAN" ? (
              <>
                <option value="true">{t("fields.form.yes")}</option>
                <option value="false">{t("fields.form.no")}</option>
              </>
            ) : (
              options.map((option) => (
                <option key={option.id} value={option.id} disabled={option.archived}>
                  {option.archived
                    ? t("fields.option.retired", { label: option.label })
                    : option.label}
                </option>
              ))
            )}
          </Select>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Input
              {...props}
              type={field.type === "DATE" ? "date" : field.type === "LINK" ? "url" : "text"}
              inputMode={field.type === "NUMBER" ? "decimal" : undefined}
              className="min-w-0 flex-1"
            />
            {field.unit ? (
              <span className="text-muted-foreground shrink-0 text-sm">{field.unit}</span>
            ) : null}
          </div>
        )}
      </div>
      {error ? (
        <p id={`${name}.error`} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MultipleChoice({
  field,
  options,
  value,
  onChange,
}: {
  field: Field;
  options: Field["options"];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const archived = options.some((option) => option.archived && value.includes(option.id));
  const choices = (
    <div className="flex flex-col gap-2">
      {field.options.filter((option) => !option.archived).length > 8 ? (
        <Input
          aria-label={t("fields.form.search", { name: field.name })}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      ) : null}
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {options
          .filter((option) => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map((option) => (
            <label
              key={option.id}
              className="flex min-h-8 cursor-pointer items-start gap-2 text-sm [overflow-wrap:anywhere]"
            >
              <input
                type="checkbox"
                className="accent-primary mt-1 size-4 shrink-0"
                checked={value.includes(option.id)}
                disabled={option.archived}
                onChange={(event) => {
                  const active = value.filter((id) =>
                    field.options.some((option) => option.id === id && !option.archived),
                  );
                  onChange(
                    event.currentTarget.checked
                      ? [...active, option.id]
                      : active.filter((id) => id !== option.id),
                  );
                }}
              />
              {option.archived ? t("fields.option.retired", { label: option.label }) : option.label}
            </label>
          ))}
      </div>
      {value.length ? (
        <button
          type="button"
          className="text-muted-foreground self-start text-xs underline underline-offset-4"
          onClick={() => onChange([])}
        >
          {t("fields.form.clear")}
        </button>
      ) : null}
    </div>
  );
  return (
    <>
      {archived ? (
        <p className="text-muted-foreground text-xs">{t("fields.form.archivedSelection")}</p>
      ) : null}
      {field.options.filter((option) => !option.archived).length > 8 ? (
        <details className="border-border rounded-md border p-2">
          <summary className="cursor-pointer text-sm [overflow-wrap:anywhere]">
            {value.length
              ? options
                  .filter((option) => value.includes(option.id))
                  .map((option) =>
                    option.archived
                      ? t("fields.option.retired", { label: option.label })
                      : option.label,
                  )
                  .join(", ")
              : t("fields.form.unset")}
          </summary>
          <div className="mt-2">{choices}</div>
        </details>
      ) : (
        choices
      )}
    </>
  );
}
