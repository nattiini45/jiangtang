import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";
import {
  PORT_CONNECTORS,
  PORT_DIRECTIONS,
  PORT_SIGNALS,
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

export function PortFields({
  value,
  onChange,
  device = false,
}: {
  value: PortDraft;
  onChange: (value: PortDraft) => void;
  device?: boolean;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-sm">
        {t("ports.label")}
        <Input
          required
          maxLength={120}
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </label>
      <label className="grid min-w-0 gap-1 text-sm">
        {t("ports.connector")}
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
      <label className="grid min-w-0 gap-1 text-sm">
        {t("ports.direction")}
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
      <label className="grid min-w-0 gap-1 text-sm">
        {t("ports.signal")}
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
              max={10000}
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
      <fetcher.Form method="post" className="grid gap-4" aria-busy={busy}>
        <input type="hidden" name="_action" value="modelPorts" />
        <input type="hidden" name="ports" value={JSON.stringify(rows)} />
        <PortResult data={fetcher.data} />
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("ports.empty")}</p>
        ) : null}
        {rows.map((row, index) => (
          <fieldset key={row.key} className="grid min-w-0 gap-2 border-b pb-4">
            <legend className="mb-2 max-w-full truncate text-sm font-semibold">
              {row.label || t("ports.add")}
            </legend>
            <PortFields
              value={row}
              onChange={(value) =>
                setRows(rows.map((p, i) => (i === index ? { ...row, ...value } : p)))
              }
            />
            <div className="flex flex-wrap justify-end gap-2">
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
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <Trash2 />
                {t("ports.remove")}
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
          <li key={port.id} className="grid gap-2 py-row">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
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
            <details>
              <summary
                className="cursor-pointer text-sm"
                aria-label={t("ports.editPort", { label: port.label })}
              >
                {t("ports.edit")}
              </summary>
              <DevicePortEditor key={port.id} port={port} position={port.position} />
            </details>
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
