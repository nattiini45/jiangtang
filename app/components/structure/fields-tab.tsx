import { useCallback, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { loader, action } from "~/routes/_desktop.admin.structure/route";
import { useT } from "~/i18n/use-t";
import { applies, fieldGroups } from "~/lib/custom-fields/fields";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { FieldPanel } from "./field-panel";

export type StructureFields = Awaited<ReturnType<typeof loader>>["fields"];
export type StructureGroups = Awaited<ReturnType<typeof loader>>["groups"];
export type AdminField = StructureFields[number];

export function FieldsTab({
  fields,
  groups,
  showArchived,
}: {
  fields: StructureFields;
  groups: StructureGroups;
  showArchived: boolean;
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") === "ROOM" ? "ROOM" : "EQUIPMENT";
  const kindId = params.get("kind") || "";
  const [selected, setSelected] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setSelected(null);
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  const open = (id: string, element: HTMLElement) => {
    opener.current = element;
    setSelected(id);
  };
  const fetcher = useFetcher<typeof action>();
  const kinds = groups.flatMap((group) => group.kinds);
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setSelected(null);
    setParams(next);
  };
  const visible = fields.filter(
    (field) =>
      field.scope === scope &&
      field.origin === "own" &&
      (showArchived || !field.archivedAt) &&
      (scope === "ROOM" || applies(field, kindId)),
  );
  const sections = fieldGroups(visible);
  const libraryKinds = kinds.filter(
    (kind) =>
      (!kindId || kind.id === kindId) &&
      fields.some(
        (field) =>
          field.origin === "library" && field.kinds.some((link) => link.kindId === kind.id),
      ),
  );
  const move = (id: string, direction: "up" | "down", section: boolean) => {
    void fetcher.submit(
      {
        intent: "field",
        payload: JSON.stringify({
          op: "move",
          input: { id, direction, section, kindId: kindId || undefined, showArchived },
        }),
      },
      { method: "post" },
    );
  };
  const coverage = (field: AdminField) =>
    field.scope === "ROOM"
      ? t("fields.name.allRooms")
      : !field.kinds.length
        ? t("fields.name.allKinds")
        : field.kinds
            .map((link) => {
              const kind = kinds.find((kind) => kind.id === link.kindId);
              return kind
                ? `${kind.name}${kind.archivedAt ? ` (${t("admin.structure.archived")})` : ""}`
                : "";
            })
            .join(", ");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="flex gap-1" aria-label={t("fields.admin.scope")}>
          {(["ROOM", "EQUIPMENT"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              variant={scope === value ? "secondary" : "ghost"}
              aria-pressed={scope === value}
              onClick={() => changeFilter("scope", value)}
            >
              {t(value === "ROOM" ? "fields.admin.rooms" : "fields.admin.devices")}
            </Button>
          ))}
        </fieldset>
        {scope === "EQUIPMENT" ? (
          <label className="min-w-48 max-w-sm flex-1 text-sm">
            {t("fields.admin.viewKind")}
            <Select
              aria-label={t("fields.admin.viewKind")}
              value={kindId}
              onChange={(event) => changeFilter("kind", event.target.value)}
            >
              <option value="">{t("fields.name.allKinds")}</option>
              {groups.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.kinds.map((kind) => (
                    <option key={kind.id} value={kind.id}>
                      {kind.name}
                      {kind.archivedAt ? ` (${t("admin.structure.archived")})` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="button" onClick={(event) => open("new", event.currentTarget)}>
            <Plus className="size-icon" />
            {t("fields.admin.add")}
          </Button>
        </div>
      </div>
      {scope === "EQUIPMENT" && !kindId ? (
        <p className="text-muted-foreground text-sm">{t("fields.admin.everyKindHint")}</p>
      ) : null}
      <div className="flex items-start gap-5 max-lg:flex-col">
        <div className="min-w-0 flex-1 space-y-4 max-lg:w-full">
          {sections.length ? (
            sections.map((group, groupIndex) => (
              <section
                key={group.section}
                className="bg-card shadow-surface-2 overflow-hidden rounded-lg"
              >
                <div className="bg-tint flex items-center gap-2 px-4 py-2">
                  <h2
                    className="min-w-0 flex-1 truncate text-sm font-semibold"
                    title={group.section || t("fields.moreDetails")}
                  >
                    {group.section || t("fields.moreDetails")}
                  </h2>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("fields.admin.sectionMoveUp", {
                      name: group.section || t("fields.moreDetails"),
                    })}
                    disabled={fetcher.state !== "idle" || groupIndex === 0}
                    onClick={() => move(group.fields[0].id, "up", true)}
                  >
                    <ArrowUp className="size-icon" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("fields.admin.sectionMoveDown", {
                      name: group.section || t("fields.moreDetails"),
                    })}
                    disabled={fetcher.state !== "idle" || groupIndex === sections.length - 1}
                    onClick={() => move(group.fields[0].id, "down", true)}
                  >
                    <ArrowDown className="size-icon" />
                  </Button>
                </div>
                <ul>
                  {group.fields.map((field, index) => (
                    <li
                      key={field.id}
                      data-field-id={field.id}
                      className="border-border flex items-center gap-2 border-b px-3 py-row last:border-0"
                    >
                      <button
                        type="button"
                        aria-current={selected === field.id ? "true" : undefined}
                        className={`hover:bg-tint min-w-0 flex-1 rounded-md px-1 py-1 text-left ${selected === field.id ? "bg-selected" : ""}`}
                        onClick={(event) => open(field.id, event.currentTarget)}
                      >
                        <span className="block truncate text-sm font-semibold" title={field.name}>
                          {field.name}
                        </span>
                        <span
                          className="text-muted-foreground block truncate text-xs"
                          title={coverage(field)}
                        >
                          {t(`fields.type.${field.type}`)} · {coverage(field)}
                          {field.archivedAt ? ` · ${t("admin.structure.archived")}` : ""}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("fields.admin.moveUp", { name: field.name })}
                        disabled={fetcher.state !== "idle" || index === 0}
                        onClick={() => move(field.id, "up", false)}
                      >
                        <ArrowUp className="size-icon" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("fields.admin.moveDown", { name: field.name })}
                        disabled={fetcher.state !== "idle" || index === group.fields.length - 1}
                        onClick={() => move(field.id, "down", false)}
                      >
                        <ArrowDown className="size-icon" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <div className="bg-card shadow-surface-2 rounded-lg p-6">
              <h2 className="text-base font-semibold">{t("fields.admin.empty")}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{t("fields.admin.emptyHelp")}</p>
              <Button
                type="button"
                className="mt-4"
                onClick={(event) => open("new", event.currentTarget)}
              >
                {t("fields.admin.addFirst")}
              </Button>
            </div>
          )}
          {fetcher.data && !fetcher.data.changed ? (
            <p role="alert" className="text-destructive text-sm">
              {[...Object.values(fetcher.data.fieldErrors).flat(), ...fetcher.data.formErrors].join(
                " ",
              )}
            </p>
          ) : null}
          {scope === "EQUIPMENT"
            ? libraryKinds.map((kind) => {
                const properties = fields.filter(
                  (field) =>
                    field.origin === "library" &&
                    field.kinds.some((link) => link.kindId === kind.id),
                );
                return (
                  <section key={kind.id} className="mt-5 min-w-0">
                    <h2 className="mb-2 text-base font-semibold [overflow-wrap:anywhere]">
                      {kind.name}
                    </h2>
                    <details className="bg-card shadow-surface-2 rounded-lg p-4">
                      <summary className="cursor-pointer text-sm font-semibold">
                        {t("fields.library.title", { count: properties.length })}
                      </summary>
                      <ul className="mt-3 divide-y">
                        {properties.map((field) => (
                          <li
                            key={field.id}
                            className="flex min-w-0 items-start justify-between gap-4 py-row text-sm"
                          >
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                              {field.name}
                              {field.unit ? ` · ${field.unit}` : ""}
                            </span>
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {t(`fields.level.${field.level}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </section>
                );
              })
            : null}
        </div>
        {selected ? (
          <FieldPanel
            key={selected}
            field={fields.find((field) => field.id === selected)}
            scope={scope}
            kindId={kindId}
            fields={fields}
            groups={groups}
            onClose={close}
            onSelect={setSelected}
          />
        ) : null}
      </div>
    </div>
  );
}
