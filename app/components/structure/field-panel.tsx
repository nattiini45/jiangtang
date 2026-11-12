import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { X } from "lucide-react";
import type { action } from "~/routes/_desktop.admin.structure/route";
import { fieldType } from "~/lib/custom-fields/definitions.schema";
import { useT } from "~/i18n/use-t";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import type { AdminField, StructureFields, StructureGroups } from "./fields-tab";
import { FieldOptions } from "./field-options";

export function FieldPanel({
  field,
  scope,
  kindId,
  fields,
  groups,
  onClose,
  onSelect,
}: {
  field?: AdminField;
  scope: "ROOM" | "EQUIPMENT";
  kindId: string;
  fields: StructureFields;
  groups: StructureGroups;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState(field?.type ?? "TEXT");
  const [kindIds, setKindIds] = useState(
    field ? field.kinds.map((link) => link.kindId) : kindId ? [kindId] : [],
  );
  const [someKinds, setSomeKinds] = useState(kindIds.length > 0);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.changed) {
      if (fetcher.data.fieldId) onSelect(fetcher.data.fieldId);
      else onClose();
    }
  }, [fetcher.state, fetcher.data, onSelect, onClose]);
  const submit = (payload: unknown) =>
    void fetcher.submit({ intent: "field", payload: JSON.stringify(payload) }, { method: "post" });
  const sameNames = !field
    ? fields.filter(
        (row) => row.scope === scope && row.name.toLowerCase() === name.trim().toLowerCase(),
      )
    : [];
  const holders = sameNames.filter(
    (row) =>
      scope === "ROOM" ||
      !someKinds ||
      !row.kinds.length ||
      row.kinds.some((link) => kindIds.includes(link.kindId)),
  );
  const archived = holders.find((row) => row.archivedAt);
  const reusable =
    scope === "EQUIPMENT" && someKinds && kindIds.length
      ? sameNames.find((row) => !row.archivedAt && !holders.includes(row))
      : undefined;
  const errors = fetcher.data && !fetcher.data.changed ? fetcher.data : undefined;
  const conversions = field
    ? [
        field.type,
        ...(field.type === "TEXT"
          ? ["LONG_TEXT" as const]
          : field.type === "CHOICE"
            ? ["MULTI_CHOICE" as const]
            : field.type === "MULTI_CHOICE"
              ? ["CHOICE" as const]
              : []),
      ]
    : fieldType.options;
  const sections = [
    ...new Set(
      fields
        .filter((row) => row.scope === scope)
        .flatMap((row) => (row.section ? [row.section] : [])),
    ),
  ];
  return (
    <aside
      aria-label={t(field ? "fields.admin.edit" : "fields.admin.add")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
      className="bg-card shadow-surface-2 sticky top-4 w-[min(28rem,44%)] min-w-80 shrink-0 rounded-lg max-lg:static max-lg:w-full max-lg:min-w-0"
    >
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {t(field ? "fields.admin.edit" : "fields.admin.add")}
        </h2>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("common.cancel")}
          onClick={onClose}
          disabled={busy}
        >
          <X className="size-icon" />
        </Button>
      </div>
      <div className="max-h-[calc(100dvh-11rem)] space-y-5 overflow-y-auto p-4">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const input = {
              name,
              type,
              kindIds: scope === "EQUIPMENT" && someKinds ? kindIds : [],
              section: String(form.get("section") ?? "").trim() || null,
              unit: type === "NUMBER" ? String(form.get("unit") ?? "").trim() || null : null,
              helpText: String(form.get("helpText") ?? "").trim() || null,
            };
            submit(
              field
                ? { op: "update", input: { id: field.id, ...input } }
                : {
                    op: "create",
                    input: {
                      scope,
                      ...input,
                      position:
                        Math.max(
                          -1,
                          ...fields.filter((row) => row.scope === scope).map((row) => row.position),
                        ) + 1,
                    },
                  },
            );
          }}
        >
          <label className="block text-sm">
            {t("admin.structure.name")}
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
              autoFocus
              aria-invalid={!!errors?.fieldErrors.name}
              aria-describedby={errors?.fieldErrors.name ? "field-name-error" : undefined}
            />
          </label>
          {errors?.fieldErrors.name ? (
            <p id="field-name-error" role="alert" className="text-destructive text-sm">
              {errors.fieldErrors.name.join(" ")}
            </p>
          ) : null}
          {archived ? (
            <div className="bg-tint space-y-2 rounded-md p-3 text-sm">
              <p>{t("fields.admin.restoreOffer", { name: archived.name })}</p>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  submit({ op: "update", input: { id: archived.id, archived: false } })
                }
              >
                {t("fields.admin.restoreExisting")}
              </Button>
            </div>
          ) : null}
          {reusable ? (
            <div className="bg-tint space-y-2 rounded-md p-3 text-sm">
              <p>
                {t("fields.admin.reuseOffer", {
                  name: reusable.name,
                  type: t(`fields.type.${reusable.type}`),
                })}
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  submit({
                    op: "update",
                    input: {
                      id: reusable.id,
                      kindIds: [
                        ...new Set([...reusable.kinds.map((link) => link.kindId), ...kindIds]),
                      ],
                    },
                  })
                }
              >
                {t("fields.admin.reuse")}
              </Button>
            </div>
          ) : null}
          {errors?.holderId ? (
            <Button type="button" variant="link" onClick={() => onSelect(errors.holderId!)}>
              {t("fields.admin.openHolder")}
            </Button>
          ) : null}
          <label className="block text-sm">
            {t("fields.admin.type")}
            <Select
              value={type}
              aria-label={t("fields.admin.type")}
              onChange={(event) => setType(event.target.value as typeof type)}
              disabled={conversions.length === 1}
            >
              {conversions.map((value) => (
                <option key={value} value={value}>
                  {t(`fields.type.${value}`)}
                </option>
              ))}
            </Select>
          </label>
          {field && conversions.length === 1 ? (
            <p className="text-muted-foreground text-xs">{t("fields.admin.typeLocked")}</p>
          ) : null}
          {field && type !== field.type ? (
            <p role="status" className="text-sm">
              {t(
                type === "LONG_TEXT"
                  ? "fields.admin.convertText"
                  : type === "MULTI_CHOICE"
                    ? "fields.admin.convertMulti"
                    : "fields.admin.convertSingle",
              )}
            </p>
          ) : null}
          {scope === "EQUIPMENT" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">{t("fields.admin.applies")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="coverage"
                  checked={!someKinds}
                  onChange={() => setSomeKinds(false)}
                />
                {t("fields.name.allKinds")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="coverage"
                  checked={someKinds}
                  onChange={() => setSomeKinds(true)}
                />
                {t("fields.admin.chosenKinds")}
              </label>
              {someKinds ? (
                <div className="max-h-48 space-y-3 overflow-y-auto rounded-md bg-tint p-3">
                  {groups.map((group) => {
                    const choices = group.kinds.filter(
                      (kind) => !kind.archivedAt || kindIds.includes(kind.id),
                    );
                    if (!choices.length) return null;
                    return (
                      <fieldset key={group.id} className="space-y-1">
                        <legend className="mb-1 text-xs font-semibold">{group.name}</legend>
                        {choices.map((kind) => (
                          <label key={kind.id} className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={kindIds.includes(kind.id)}
                              disabled={!!kind.archivedAt && !kindIds.includes(kind.id)}
                              onChange={(event) =>
                                setKindIds(
                                  event.target.checked
                                    ? [...kindIds, kind.id]
                                    : kindIds.filter((id) => id !== kind.id),
                                )
                              }
                            />
                            <span className="min-w-0 wrap-anywhere">
                              {kind.name}
                              {kind.archivedAt ? ` (${t("admin.structure.archived")})` : ""}
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    );
                  })}
                </div>
              ) : null}
              {someKinds && !kindIds.length ? (
                <p className="text-muted-foreground text-xs">{t("fields.admin.chooseOne")}</p>
              ) : null}
            </fieldset>
          ) : (
            <p className="text-muted-foreground text-sm">{t("fields.name.allRooms")}</p>
          )}
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-semibold">
              {t("fields.admin.moreSettings")}
            </summary>
            <label className="block text-sm">
              {t("fields.admin.section")}
              <Input
                name="section"
                list="field-sections"
                defaultValue={field?.section ?? ""}
                maxLength={60}
              />
              <datalist id="field-sections">
                {sections.map((section) => (
                  <option key={section} value={section} />
                ))}
              </datalist>
            </label>
            {type === "NUMBER" ? (
              <label className="block text-sm">
                {t("fields.admin.unit")}
                <Input name="unit" defaultValue={field?.unit ?? ""} maxLength={12} />
              </label>
            ) : null}
            <label className="block text-sm">
              {t("fields.admin.help")}
              <Textarea
                name="helpText"
                defaultValue={field?.helpText ?? ""}
                maxLength={300}
                rows={2}
              />
            </label>
            {field ? (
              <label className="block text-sm">
                {t("fields.admin.key")}
                <Input value={field.key} readOnly className="font-mono" />
              </label>
            ) : null}
          </details>
          <div role="alert" className="text-destructive text-sm">
            {errors
              ? [
                  ...Object.entries(errors.fieldErrors)
                    .filter(([key]) => key !== "name")
                    .flatMap(([, messages]) => messages),
                  ...errors.formErrors,
                ].join(" ")
              : ""}
          </div>
          <Button disabled={busy || (scope === "EQUIPMENT" && someKinds && !kindIds.length)}>
            {t("common.save")}
          </Button>
          {fetcher.data?.changed ? (
            <span role="status" className="ml-3 text-muted-foreground text-sm">
              {t("fields.admin.saved")}
            </span>
          ) : null}
        </form>
        {field && (field.type === "CHOICE" || field.type === "MULTI_CHOICE") ? (
          <FieldOptions field={field} />
        ) : null}
        {field ? (
          <div className="border-border flex flex-wrap gap-2 border-t pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                submit({ op: "update", input: { id: field.id, archived: !field.archivedAt } })
              }
            >
              {t(field.archivedAt ? "admin.structure.restore" : "admin.structure.archive")}
            </Button>
            {field.archivedAt ? (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("fields.admin.deleteConfirm", { name: field.name })))
                    submit({ op: "delete", id: field.id, confirm: true });
                }}
              >
                {t("common.delete")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
