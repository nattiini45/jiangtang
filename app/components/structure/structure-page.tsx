import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import type { loader, action } from "~/routes/_desktop.admin.structure/route";
import type { FieldErrors } from "~/lib/errors.server";
import { useT } from "~/i18n/use-t";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";

type Groups = Awaited<ReturnType<typeof loader>>["groups"];
type Entry = Pick<Groups[number], "id" | "name" | "archivedAt" | "updatedAt"> & {
  systemKey?: string | null;
  groupId?: string;
  _count?: { equipment: number; models: number };
};
const protectedKeys: string[] = Object.values(DEFAULT_EQUIPMENT_KINDS).map((kind) => kind.key);

function Errors({
  result,
}: {
  result: { changed: boolean; fieldErrors: FieldErrors; formErrors: string[] } | undefined;
}) {
  if (!result || result.changed) return null;
  return (
    <div role="alert" className="text-destructive text-sm">
      {[...Object.values(result.fieldErrors).flat(), ...result.formErrors].join(" ")}
    </div>
  );
}

function GroupOptions({ groups }: { groups: Groups }) {
  return groups
    .filter((group) => !group.archivedAt)
    .map((group) => (
      <option key={group.id} value={group.id}>
        {group.name}
      </option>
    ));
}

function StructureRow({
  entry,
  entity,
  groups,
  index,
  count,
}: {
  entry: Entry;
  entity: "kind" | "group";
  groups: Groups;
  index: number;
  count: number;
}) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const protectedKind =
    entity === "kind" && !!entry.systemKey && protectedKeys.includes(entry.systemKey);
  const inUse = !!entry._count && entry._count.equipment + entry._count.models > 0;
  useEffect(() => {
    if (archiving) dialog.current?.showModal();
  }, [archiving]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.changed) {
      setEditing(false);
      dialog.current?.close();
    }
  }, [fetcher.state, fetcher.data]);
  const submit = (intent: string, extra: Record<string, string> = {}) => {
    void fetcher.submit({ entity, id: entry.id, intent, ...extra }, { method: "post" });
  };
  return (
    <li className="border-border border-b last:border-0" data-entry-id={entry.id} aria-busy={busy}>
      <div className="flex min-h-control flex-wrap items-center gap-3 px-4 py-row">
        {editing ? (
          <fetcher.Form method="post" className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="intent" value="update" />
            <label className="min-w-40 flex-1 text-sm">
              {t("admin.structure.name")}
              <Input
                name="name"
                defaultValue={entry.name}
                required
                maxLength={60}
                aria-invalid={!!fetcher.data?.fieldErrors?.name}
                autoFocus
              />
            </label>
            {entity === "kind" ? (
              <label className="min-w-40 flex-1 text-sm">
                {t("admin.structure.group")}
                <Select
                  name="groupId"
                  defaultValue={entry.groupId}
                  aria-label={t("admin.structure.group")}
                >
                  <GroupOptions groups={groups} />
                  {groups
                    .filter((group) => group.archivedAt && group.id === entry.groupId)
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                </Select>
              </label>
            ) : null}
            <Button disabled={busy}>{t("common.save")}</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </fetcher.Form>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm" title={entry.name}>
                {entry.name}
              </span>
              {entry.archivedAt ? (
                <span className="text-muted-foreground text-xs">
                  {t("admin.structure.archived")}
                </span>
              ) : null}
            </div>
            {entry._count ? (
              <p className="text-muted-foreground nums text-sm">
                {t("admin.structure.counts", {
                  devices: t(
                    entry._count.equipment === 1
                      ? "admin.structure.deviceOne"
                      : "admin.structure.deviceMany",
                    { count: entry._count.equipment },
                  ),
                  models: t(
                    entry._count.models === 1
                      ? "admin.structure.modelOne"
                      : "admin.structure.modelMany",
                    { count: entry._count.models },
                  ),
                })}
              </p>
            ) : null}
            <div className="flex shrink-0 items-center gap-1">
              {!entry.archivedAt ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("admin.structure.up")}
                    disabled={busy || index === 0}
                    onClick={() => submit("reorder", { position: String(index - 1) })}
                  >
                    <ArrowUp className="size-icon" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("admin.structure.down")}
                    disabled={busy || index === count - 1}
                    onClick={() => submit("reorder", { position: String(index + 1) })}
                  >
                    <ArrowDown className="size-icon" />
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("admin.structure.edit")}
                disabled={busy}
                onClick={() => {
                  fetcher.reset();
                  setEditing(true);
                }}
              >
                <Pencil className="size-icon" />
              </Button>
              {entry.archivedAt ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => submit("restore")}
                  >
                    {t("admin.structure.restore")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || protectedKind}
                    onClick={() => {
                      if (window.confirm(t("admin.structure.deleteConfirm", { name: entry.name })))
                        submit("delete");
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </>
              ) : protectedKind ? (
                <span
                  className="text-muted-foreground max-w-48 text-xs"
                  title={t("admin.structure.protected")}
                >
                  {t("admin.structure.legacy")}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    fetcher.reset();
                    if (inUse) setArchiving(true);
                    else submit("archive");
                  }}
                >
                  {t("admin.structure.archive")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="px-4">
        <Errors result={fetcher.data} />
      </div>
      {archiving ? (
        <dialog
          ref={dialog}
          onClose={() => setArchiving(false)}
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
          aria-labelledby={`archive-${entry.id}`}
          className="bg-card text-foreground shadow-surface-5 fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-xl p-6 backdrop:bg-(--scrim)"
        >
          <fetcher.Form method="post" className="flex flex-col gap-4">
            <h2 id={`archive-${entry.id}`} className="text-lg font-semibold">
              {t("admin.structure.archiveTitle", { name: entry.name })}
            </h2>
            <p className="text-muted-foreground text-sm">{t("admin.structure.moveHelp")}</p>
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="intent" value="archive" />
            <label className="text-sm">
              {t("admin.structure.moveTo")}
              <Select
                name="moveDevicesTo"
                required
                defaultValue=""
                aria-label={t("admin.structure.moveTo")}
              >
                <option value="" disabled>
                  {t("admin.structure.chooseKind")}
                </option>
                {groups
                  .filter((group) => !group.archivedAt)
                  .map((group) => (
                    <optgroup key={group.id} label={group.name}>
                      {group.kinds
                        .filter((kind) => !kind.archivedAt && kind.id !== entry.id)
                        .map((kind) => (
                          <option key={kind.id} value={kind.id}>
                            {kind.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </Select>
            </label>
            <Errors result={fetcher.data} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => dialog.current?.close()}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
              <Button disabled={busy}>{t("admin.structure.archiveAndMove")}</Button>
            </div>
          </fetcher.Form>
        </dialog>
      ) : null}
    </li>
  );
}

export function StructurePage({
  groups,
  libraryAction,
}: {
  groups: Groups;
  libraryAction?: React.ReactNode;
}) {
  const t = useT();
  const [params] = useSearchParams();
  const entity = params.get("tab") === "groups" ? "group" : "kind";
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.changed) setAdding(false);
  }, [fetcher.state, fetcher.data]);
  const visibleGroups = groups
    .filter((group) => showArchived || !group.archivedAt)
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-bold">{t("admin.structure.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("admin.structure.subtitle")}</p>
      </header>
      <nav aria-label={t("admin.structure.tabs")} className="border-border flex gap-6 border-b">
        {(
          [
            ["kind", "kinds"],
            ["group", "groups"],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            to={`?tab=${label}`}
            onClick={() => setAdding(false)}
            aria-current={entity === value ? "page" : undefined}
            className={`py-2 text-sm ${entity === value ? "border-foreground border-b-2 font-semibold" : "text-muted-foreground"}`}
          >
            {t(`admin.structure.${label}`)}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="show-archived"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          <label htmlFor="show-archived" className="text-sm">
            {t("admin.structure.showArchived")}
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {entity === "kind" ? libraryAction : null}
          <Button
            type="button"
            onClick={() => {
              fetcher.reset();
              setAdding(true);
            }}
          >
            {t(entity === "kind" ? "admin.structure.addKind" : "admin.structure.addGroup")}
          </Button>
        </div>
      </div>
      {adding ? (
        <fetcher.Form
          key={entity}
          method="post"
          className="bg-card shadow-surface-2 flex flex-wrap items-end gap-3 rounded-lg p-4"
        >
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="intent" value="create" />
          <label className="min-w-48 flex-1 text-sm">
            {t("admin.structure.name")}
            <Input
              name="name"
              maxLength={60}
              required
              autoFocus
              aria-invalid={!!fetcher.data?.fieldErrors?.name}
            />
          </label>
          {entity === "kind" ? (
            <label className="min-w-48 flex-1 text-sm">
              {t("admin.structure.group")}
              <Select name="groupId" required aria-label={t("admin.structure.group")}>
                <GroupOptions groups={groups} />
              </Select>
            </label>
          ) : null}
          <Button disabled={fetcher.state !== "idle"}>{t("common.save")}</Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
          <div className="w-full">
            <Errors result={fetcher.data} />
          </div>
        </fetcher.Form>
      ) : null}
      {entity === "kind" ? (
        visibleGroups.map((group) => {
          const kinds = group.kinds
            .filter((kind) => showArchived || !kind.archivedAt)
            .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
          return (
            <section key={group.id} className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
              <h2 className="bg-tint px-4 py-2 text-sm font-semibold">
                <span className="block truncate" title={group.name}>
                  {group.name}
                </span>
              </h2>
              {kinds.length ? (
                <ul>
                  {kinds.map((kind, index) => (
                    <StructureRow
                      key={kind.id}
                      entry={kind}
                      entity="kind"
                      groups={groups}
                      index={index}
                      count={kinds.filter((kind) => !kind.archivedAt).length}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground px-4 py-3 text-sm">
                  {t("admin.structure.emptyKinds")}
                </p>
              )}
            </section>
          );
        })
      ) : (
        <section className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
          <ul>
            {visibleGroups.map((group, index) => (
              <StructureRow
                key={group.id}
                entry={group}
                entity="group"
                groups={groups}
                index={index}
                count={visibleGroups.filter((group) => !group.archivedAt).length}
              />
            ))}
          </ul>
        </section>
      )}
      <p role="status" className="text-muted-foreground text-sm">
        {fetcher.state !== "idle"
          ? t("admin.invitations.saving")
          : fetcher.data?.changed
            ? t("admin.invitations.saved")
            : ""}
      </p>
    </div>
  );
}
