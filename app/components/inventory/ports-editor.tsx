import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";
import {
  PORT_CONNECTORS,
  PORT_DIRECTIONS,
  PORT_SIGNALS,
  MAX_PORT_POSITION,
  type PortInput,
} from "~/domains/inventory/inventory.ports.schema";

export const blankPort: PortInput = {
  label: "",
  connector: "HDMI",
  direction: "INPUT",
  signal: "VIDEO",
  position: 0,
  note: "",
};
type PortDraft = Omit<PortInput, "connector"> & { connector: string };
export type PortRow = PortDraft & {
  id: string;
  connection?: {
    id: string;
    note: string | null;
    other: {
      id: string;
      label: string;
      equipment: { id: string; name: string | null; assetTag: string | null; status: string };
    };
  } | null;
};
export function connectorKey(connector: string) {
  return PORT_CONNECTORS.find((key) => key === connector) ?? "OTHER";
}

function portDeviceLabel(device: { id: string; name: string | null; assetTag: string | null }) {
  return device.name
    ? `${device.name}${device.assetTag ? ` (${device.assetTag})` : ""}`
    : (device.assetTag ?? device.id);
}

export function duplicatePortLabel(original: string, existing: ReadonlySet<string>) {
  const match = original.trim().match(/^(.*?)(\d+)$/);
  const base = match ? match[1] : `${original.trim()} `;
  let number = match ? BigInt(match[2]) : 1n;
  let label: string;
  do {
    const suffix = String(++number).slice(-120);
    label = `${base.slice(0, 120 - suffix.length)}${suffix}`;
  } while (existing.has(label));
  return label;
}

export function PortFields({
  value,
  onChange,
  device = false,
  row = false,
}: {
  value: PortDraft;
  onChange: (value: PortDraft) => void;
  device?: boolean;
  row?: boolean;
}) {
  const t = useT();
  const fieldClass = row ? "grid min-w-0 gap-1 text-sm lg:contents" : "grid min-w-0 gap-1 text-sm";
  return (
    <div className={row ? "contents" : "grid min-w-0 gap-3 sm:grid-cols-2"}>
      <label className={fieldClass}>
        <span className={row ? "lg:sr-only" : undefined}>{t("ports.label")}</span>
        <Input
          required
          maxLength={120}
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </label>
      <label className={fieldClass}>
        <span className={row ? "lg:sr-only" : undefined}>{t("ports.connector")}</span>
        <Select
          value={value.connector}
          onChange={(e) =>
            onChange({ ...value, connector: e.target.value as PortInput["connector"] })
          }
        >
          {PORT_CONNECTORS.map((key) => (
            <option key={key} value={key}>
              {t(`ports.connector.${key}`)}
            </option>
          ))}
        </Select>
      </label>
      <label className={fieldClass}>
        <span className={row ? "lg:sr-only" : undefined}>{t("ports.direction")}</span>
        <Select
          value={value.direction}
          onChange={(e) =>
            onChange({ ...value, direction: e.target.value as PortInput["direction"] })
          }
        >
          {PORT_DIRECTIONS.map((key) => (
            <option key={key} value={key}>
              {t(`ports.direction.${key}`)}
            </option>
          ))}
        </Select>
      </label>
      <label className={fieldClass}>
        <span className={row ? "lg:sr-only" : undefined}>{t("ports.signal")}</span>
        <Select
          value={value.signal}
          onChange={(e) => onChange({ ...value, signal: e.target.value as PortInput["signal"] })}
        >
          {PORT_SIGNALS.map((key) => (
            <option key={key} value={key}>
              {t(`ports.signal.${key}`)}
            </option>
          ))}
        </Select>
      </label>
      {device ? (
        <>
          <label className="grid min-w-0 gap-1 text-sm">
            {t("ports.position")}
            <Input
              type="number"
              min={0}
              max={MAX_PORT_POSITION}
              required
              value={value.position}
              onChange={(e) => onChange({ ...value, position: Number(e.target.value) })}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-sm">
            {t("ports.note")}
            <Input
              maxLength={2000}
              value={value.note ?? ""}
              onChange={(e) => onChange({ ...value, note: e.target.value })}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

export function PortResult({ data }: { data?: { portError?: string; portsSaved?: boolean } }) {
  const t = useT();
  return (
    <div hidden={!data?.portError && !data?.portsSaved}>
      <p role="alert" className="text-destructive text-sm">
        {data?.portError}
      </p>
      <p role="status" className="text-muted-foreground text-sm">
        {data?.portsSaved ? t("ports.saved") : null}
      </p>
    </div>
  );
}

export function ModelPortsEditor({ ports }: { ports: PortRow[] }) {
  const t = useT();
  const fetcher = useFetcher<{ portError?: string; portsSaved?: boolean }>();
  const [rows, setRows] = useState(ports.map((port) => ({ ...port, key: port.id })));
  const [announcement, setAnnouncement] = useState("");
  const busy = fetcher.state !== "idle";
  const columns =
    "grid grid-cols-2 items-center gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]";
  function duplicate(index: number) {
    const original = rows[index];
    const label = duplicatePortLabel(original.label, new Set(rows.map((row) => row.label)));
    setRows([
      ...rows.slice(0, index + 1),
      { ...original, label, id: "", key: crypto.randomUUID() },
      ...rows.slice(index + 1),
    ]);
  }
  function move(index: number, step: number) {
    const next = [...rows];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setRows(next);
    setAnnouncement(t("ports.moved", { label: rows[index].label, position: index + step + 1 }));
  }
  return (
    <section
      className="bg-card shadow-surface-2 grid gap-4 rounded-lg p-4"
      aria-label={t("ports.heading")}
    >
      <div>
        <h2 className="text-base font-semibold">{t("ports.heading")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("ports.templateHint")}</p>
      </div>
      <fetcher.Form method="post" className="grid gap-2" aria-busy={busy}>
        <input type="hidden" name="_action" value="modelPorts" />
        <input type="hidden" name="ports" value={JSON.stringify(rows)} />
        <PortResult data={fetcher.data} />
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("ports.empty")}</p>
        ) : null}
        {rows.length ? (
          <div
            className={`${columns} text-muted-foreground hidden text-sm lg:grid`}
            aria-hidden="true"
          >
            <span>{t("ports.label")}</span>
            <span>{t("ports.connector")}</span>
            <span>{t("ports.direction")}</span>
            <span>{t("ports.signal")}</span>
            <span className="w-36" />
          </div>
        ) : null}
        {rows.map((row, index) => (
          <fieldset key={row.key} className={`${columns} min-w-0`}>
            <legend className="sr-only">{row.label || t("ports.add")}</legend>
            <PortFields
              row
              value={row}
              onChange={(value) =>
                setRows(rows.map((p, i) => (i === index ? { ...row, ...value } : p)))
              }
            />
            <div className="col-span-2 flex justify-end lg:col-span-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("ports.up")}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("ports.down")}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("ports.duplicatePort", { label: row.label })}
                title={t("ports.duplicatePort", { label: row.label })}
                disabled={busy || !row.label.trim() || rows.length >= 200}
                onClick={() => duplicate(index)}
              >
                <Copy />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("ports.removePort", { label: row.label })}
                title={t("ports.removePort", { label: row.label })}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={busy || rows.length >= 200}
            onClick={() => setRows([...rows, { ...blankPort, id: "", key: crypto.randomUUID() }])}
          >
            {t("ports.add")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("ports.save")}
          </Button>
        </div>
      </fetcher.Form>
    </section>
  );
}

function DevicePortEditor({ port, position }: { port?: PortRow; position: number }) {
  const t = useT();
  const fetcher = useFetcher<{ portError?: string; portsSaved?: boolean }>();
  const [value, setValue] = useState<PortDraft>(port ?? { ...blankPort, position });
  const saved = useRef<unknown>(undefined);
  useEffect(() => {
    if (
      !port &&
      fetcher.state === "idle" &&
      fetcher.data?.portsSaved &&
      saved.current !== fetcher.data
    ) {
      saved.current = fetcher.data;
      setValue({ ...blankPort, position });
    }
  }, [fetcher.data, fetcher.state, port, position]);
  return (
    <fetcher.Form method="post" className="mt-3 grid gap-3">
      <input type="hidden" name="_action" value={port ? "portUpdate" : "portAdd"} />
      <input type="hidden" name="portId" value={port?.id ?? ""} />
      <input type="hidden" name="port" value={JSON.stringify(value)} />
      <PortFields value={value} onChange={setValue} device />
      <PortResult data={fetcher.data} />
      <Button type="submit" className="justify-self-start" disabled={fetcher.state !== "idle"}>
        {t("common.save")}
      </Button>
    </fetcher.Form>
  );
}

export function EquipmentPorts({
  equipmentId,
  ports,
  hasModel,
}: {
  equipmentId: string;
  ports: PortRow[];
  hasModel: boolean;
}) {
  const t = useT();
  const fetcher = useFetcher<{ portError?: string; portsSaved?: boolean }>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  return (
    <section
      className="bg-card shadow-surface-2 grid gap-4 rounded-lg p-4"
      aria-label={t("ports.heading")}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("ports.heading")}</h2>
        {hasModel ? (
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="portInherit" />
            <Button variant="secondary" disabled={fetcher.state !== "idle"}>
              {t("ports.inherit")}
            </Button>
          </fetcher.Form>
        ) : null}
      </header>
      <PortResult data={fetcher.data} />
      {ports.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("ports.empty")}</p>
      ) : null}
      <ul className="divide-y">
        {ports.map((port) => (
          <li key={port.id} id={`port-${port.id}`} className="py-row">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold" title={port.label}>
                  {port.label}
                </h3>
                <p className="text-muted-foreground text-xs">
                  {t(`ports.connector.${connectorKey(port.connector)}`)} ·{" "}
                  {t(`ports.direction.${port.direction}`)} · {t(`ports.signal.${port.signal}`)}
                </p>
                {port.note ? <p className="mt-1 text-sm wrap-anywhere">{port.note}</p> : null}
              </div>
              <div className="min-w-0 text-sm">
                {port.connection ? (
                  <>
                    <span className="flex min-w-0 items-baseline gap-1">
                      <Link
                        to={`/inventory/${port.connection.other.equipment.id}`}
                        className="min-w-0 truncate underline underline-offset-4"
                        title={portDeviceLabel(port.connection.other.equipment)}
                      >
                        {portDeviceLabel(port.connection.other.equipment)}
                      </Link>
                      <span className="shrink-0"> · </span>
                      <Link
                        to={`/inventory/${port.connection.other.equipment.id}#port-${port.connection.other.id}`}
                        className="max-w-1/2 shrink-0 truncate underline underline-offset-4"
                        title={port.connection.other.label}
                      >
                        {port.connection.other.label}
                      </Link>
                    </span>
                    {port.connection.other.equipment.status === "RETIRED" ? (
                      <p className="text-muted-foreground text-xs">{t("ports.retired")}</p>
                    ) : null}
                    {port.connection.note ? (
                      <p
                        className="text-muted-foreground truncate text-xs"
                        title={port.connection.note}
                      >
                        {port.connection.note}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">{t("ports.free")}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {port.connection ? (
                  <fetcher.Form
                    method="post"
                    onSubmit={(event) => {
                      if (
                        !confirm(
                          t("ports.confirmDisconnect", {
                            label: port.label,
                            device:
                              port.connection!.other.equipment.name ??
                              port.connection!.other.equipment.assetTag ??
                              port.connection!.other.equipment.id,
                            port: port.connection!.other.label,
                          }),
                        )
                      )
                        event.preventDefault();
                    }}
                  >
                    <input type="hidden" name="_action" value="portDisconnect" />
                    <input type="hidden" name="connectionId" value={port.connection.id} />
                    <Button
                      variant="ghost"
                      size="compact"
                      disabled={fetcher.state !== "idle"}
                      aria-label={t("ports.disconnectPort", { label: port.label })}
                    >
                      {t("ports.disconnect")}
                    </Button>
                  </fetcher.Form>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    aria-expanded={connectingId === port.id}
                    aria-controls={`connect-${port.id}`}
                    aria-label={t("ports.connectPort", { label: port.label })}
                    onClick={() => setConnectingId(connectingId === port.id ? null : port.id)}
                  >
                    {t("ports.connect")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  aria-label={t("ports.editPort", { label: port.label })}
                  aria-expanded={editingId === port.id}
                  aria-controls={`edit-${port.id}`}
                  onClick={() => setEditingId(editingId === port.id ? null : port.id)}
                >
                  {t("ports.edit")}
                </Button>
                <fetcher.Form
                  method="post"
                  onSubmit={(event) => {
                    if (!confirm(t("ports.confirmRemove", { label: port.label })))
                      event.preventDefault();
                  }}
                >
                  <input type="hidden" name="_action" value="portRemove" />
                  <input type="hidden" name="portId" value={port.id} />
                  <Button
                    variant="ghost"
                    size="compact"
                    aria-label={t("ports.removePort", { label: port.label })}
                    disabled={fetcher.state !== "idle"}
                  >
                    {t("ports.remove")}
                  </Button>
                </fetcher.Form>
              </div>
            </div>
            {editingId === port.id ? (
              <div id={`edit-${port.id}`}>
                <DevicePortEditor key={port.id} port={port} position={port.position} />
              </div>
            ) : null}
            {connectingId === port.id && !port.connection ? (
              <div id={`connect-${port.id}`}>
                <ConnectPort equipmentId={equipmentId} port={port} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">{t("ports.add")}</summary>
        <DevicePortEditor
          position={ports.length ? Math.max(...ports.map((port) => port.position)) + 1 : 0}
        />
      </details>
    </section>
  );
}

function usePortLookup<T>(url: string | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    url: string | null;
    data?: T;
    loading: boolean;
    failed: boolean;
  }>({ url: null, loading: false, failed: false });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({ url, loading: true, failed: false });
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setState({ url, data, loading: false, failed: false });
      } catch {
        if (!controller.signal.aborted) setState({ url, loading: false, failed: true });
      }
    })();
    return () => controller.abort();
  }, [url, revision]);
  return {
    data: state.url === url ? state.data : undefined,
    loading: !!url && (state.url !== url || state.loading),
    failed: state.url === url && state.failed,
    reload: () => setRevision((value) => value + 1),
  };
}

function ConnectPort({ equipmentId, port }: { equipmentId: string; port: PortRow }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const [targetId, setTargetId] = useState("");
  const lookup = `/api/equipment/connection-targets?equipmentId=${encodeURIComponent(equipmentId)}`;
  const devices = usePortLookup<{
    devices: {
      id: string;
      name: string | null;
      assetTag: string | null;
      status: string;
      room: { name: string } | null;
    }[];
  }>(`${lookup}&q=${encodeURIComponent(query)}`);
  const targetPorts = usePortLookup<{ ports: PortRow[]; nextPosition: number }>(
    targetId ? `${lookup}&target=${encodeURIComponent(targetId)}` : null,
  );
  const mutation = useFetcher<{ portsSaved?: boolean; portError?: string }>();
  const [targetPortId, setTargetPortId] = useState("");
  const [create, setCreate] = useState(false);
  const [draft, setDraft] = useState<PortDraft>({
    ...blankPort,
    connector: port.connector,
    signal: port.signal,
    direction: port.direction === "OUTPUT" ? "INPUT" : "OUTPUT",
  });
  const [note, setNote] = useState("");
  const ready = !!targetId && !targetPorts.loading && !!targetPorts.data;
  return (
    <div className="my-3 grid gap-3 rounded-md bg-muted/40 p-3">
      <h4 className="text-sm font-semibold">{t("ports.connectPort", { label: port.label })}</h4>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(searchText.trim());
          devices.reload();
          setTargetId("");
          setTargetPortId("");
        }}
      >
        <label className="grid min-w-0 flex-1 gap-1 text-sm">
          {t("ports.searchDevices")}
          <Input
            type="search"
            name="q"
            maxLength={120}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <Button variant="secondary" disabled={devices.loading}>
          {t("ports.search")}
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">{t("ports.sameRoomFirst")}</p>
      {devices.failed || targetPorts.failed ? (
        <p role="alert" className="text-destructive text-sm">
          {t("ports.lookupError")}
        </p>
      ) : null}
      {devices.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("ports.loading")}
        </p>
      ) : devices.data?.devices.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("ports.noDevices")}</p>
      ) : null}
      <mutation.Form method="post" className="grid gap-3">
        <input type="hidden" name="_action" value="portConnect" />
        <input
          type="hidden"
          name="connection"
          value={JSON.stringify({
            portId: port.id,
            targetEquipmentId: targetId,
            note,
            ...(create
              ? { newPort: { ...draft, position: targetPorts.data?.nextPosition ?? 0 } }
              : { targetPortId }),
          })}
        />
        <label className="grid min-w-0 gap-1 text-sm">
          {t("ports.targetDevice")}
          <Select
            required
            value={targetId}
            onChange={(event) => {
              const id = event.target.value;
              setTargetId(id);
              setTargetPortId("");
            }}
          >
            <option value="">{t("ports.chooseDevice")}</option>
            {devices.data?.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {portDeviceLabel(device)}
                {device.room ? ` · ${device.room.name}` : ""}
                {device.status === "RETIRED" ? ` · ${t("ports.retired")}` : ""}
              </option>
            ))}
          </Select>
        </label>
        {targetId && targetPorts.loading ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("ports.loading")}
          </p>
        ) : null}
        {ready ? (
          <>
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              onClick={() => setCreate(!create)}
            >
              {t(create ? "ports.useExisting" : "ports.createThere")}
            </Button>
            {create ? (
              <PortFields value={draft} onChange={setDraft} />
            ) : (
              <label className="grid min-w-0 gap-1 text-sm">
                {t("ports.targetPort")}
                <Select
                  required
                  value={targetPortId}
                  onChange={(event) => setTargetPortId(event.target.value)}
                >
                  <option value="">{t("ports.choosePort")}</option>
                  {targetPorts.data?.ports.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label} · {t(`ports.connector.${connectorKey(target.connector)}`)}
                    </option>
                  ))}
                </Select>
                {targetPorts.data?.ports.length === 0 ? (
                  <span className="text-muted-foreground text-xs">{t("ports.noFree")}</span>
                ) : null}
              </label>
            )}
            <label className="grid min-w-0 gap-1 text-sm">
              {t("ports.connectionNote")}
              <Input
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <PortResult data={mutation.data} />
        <Button
          type="submit"
          className="justify-self-start"
          disabled={!ready || mutation.state !== "idle" || (!create && !targetPortId)}
        >
          {t("ports.connect")}
        </Button>
      </mutation.Form>
    </div>
  );
}
