import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
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
export type PortRow = PortDraft & { id: string };
export function connectorKey(connector: string) {
  return PORT_CONNECTORS.find((key) => key === connector) ?? "OTHER";
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
    <div>
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

export function EquipmentPorts({ ports, hasModel }: { ports: PortRow[]; hasModel: boolean }) {
  const t = useT();
  const fetcher = useFetcher<{ portError?: string; portsSaved?: boolean }>();
  const [editingId, setEditingId] = useState<string | null>(null);
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
          <li key={port.id} className="py-row">
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
              <span className="text-muted-foreground text-sm">{t("ports.free")}</span>
              <div className="flex items-center gap-1">
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
