import { Link, useFetcher } from "react-router";
import { ChevronDown } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
} from "@ui-sdk/react/select";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { useT } from "~/i18n/use-t";
import type {
  modelParts,
  partDetail,
  partModelOptions,
} from "~/domains/inventory/inventory.parts.queries.server";

const LINK =
  "min-w-0 break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring";
const CONTROL = `${buttonVariants({ variant: "secondary" })} min-h-12 sm:min-h-control`;

function Choice({
  name,
  label,
  items,
  defaultValue,
}: {
  name: string;
  label: string;
  items: { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <Select name={name} items={items} defaultValue={defaultValue ?? items[0]?.value}>
      <SelectLabel className="text-sm">{label}</SelectLabel>
      <SelectTrigger
        className={`${fieldClassName} h-control px-control flex max-w-full min-w-0 items-center justify-between gap-2 text-start`}
      >
        <SelectValue className="min-w-0 truncate" />
        <ChevronDown aria-hidden className="text-muted-foreground size-icon shrink-0" />
      </SelectTrigger>
      <SelectContent className="bg-popover shadow-surface-3 z-50 max-h-72 max-w-(--available-width) overflow-auto rounded-lg p-1">
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            className="data-highlighted:bg-hover data-selected:bg-selected cursor-pointer rounded-md px-3 py-2 text-sm"
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StockModelLink({
  stockId,
  modelId,
  options,
}: {
  stockId: string;
  modelId: string | null;
  options: Awaited<ReturnType<typeof partModelOptions>>;
}) {
  const t = useT();
  const fetcher = useFetcher<{ partsError?: string; partsSaved?: boolean }>();
  const items = [
    { value: "none", label: t("parts.noModel") },
    ...options.map((model) => ({
      value: model.id,
      label: `${model.manufacturer ?? ""} ${model.name}`.trim(),
    })),
  ];
  return (
    <fetcher.Form
      method="post"
      action={`/inventory/stock/${stockId}`}
      aria-label={t("parts.stockModel")}
      className="bg-card shadow-surface-2 flex flex-wrap items-end gap-3 rounded-lg p-4"
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
        <Choice
          name="modelId"
          label={t("parts.partModel")}
          items={items}
          defaultValue={modelId ?? "none"}
        />
      </div>
      <Button
        type="submit"
        name="_action"
        value="linkStockModel"
        className={CONTROL}
        disabled={fetcher.state !== "idle"}
      >
        {t("parts.stockModel")}
      </Button>
      <p role="status" className="w-full text-sm">
        {fetcher.data?.partsError ?? (fetcher.data?.partsSaved ? t("parts.saved") : "")}
      </p>
    </fetcher.Form>
  );
}

function TakePart({
  fit,
  deviceId,
  retired,
}: {
  fit: Awaited<ReturnType<typeof modelParts>>[number];
  deviceId: string;
  retired: boolean;
}) {
  const t = useT();
  const fetcher = useFetcher<{ partError?: string; partTaken?: boolean }>();
  return (
    <fetcher.Form
      method="post"
      action={`/inventory/${deviceId}`}
      aria-label={t("parts.takeNamed", { name: fit.part.name })}
      className="flex min-w-0 flex-col items-start gap-2"
    >
      {fit.stock.length > 1 ? (
        <Choice
          name="stockId"
          label={t("parts.stockSource")}
          items={fit.stock.map((row) => ({
            value: row.id,
            label: `${row.location ?? row.name} · ${row.quantity}`,
          }))}
        />
      ) : (
        <input type="hidden" name="stockId" value={fit.stock[0]?.id ?? ""} />
      )}
      <Button
        type="submit"
        name="_action"
        value="takePart"
        className={CONTROL}
        disabled={fetcher.state !== "idle" || !fit.count || retired}
      >
        {t("parts.takeNamed", { name: fit.part.name })}
      </Button>
      <span className="text-sm" role="status">
        {fetcher.data?.partError ?? (fetcher.data?.partTaken ? t("parts.taken") : "")}
      </span>
    </fetcher.Form>
  );
}

export function ModelParts({
  fits,
  deviceId,
  retired = false,
}: {
  fits: Awaited<ReturnType<typeof modelParts>>;
  deviceId?: string;
  retired?: boolean;
}) {
  const t = useT();
  return (
    <section
      className="bg-card shadow-surface-2 min-w-0 rounded-lg p-4"
      aria-label={t("parts.heading")}
    >
      <h2 className="mb-3 text-base font-semibold">{t("parts.heading")}</h2>
      {!fits.length ? (
        <p className="text-muted-foreground text-sm">{t("parts.empty")}</p>
      ) : (
        <ul className="divide-border divide-y">
          {fits.map((fit) => (
            <li
              key={fit.id}
              className="flex min-w-0 flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1 basis-48">
                <Link to={`/inventory/models/${fit.part.id}`} className={`${LINK} font-semibold`}>
                  {fit.part.manufacturer} {fit.part.name}
                </Link>
                <p className="text-muted-foreground text-sm">{fit.part.kind}</p>
                <p className="mt-1 text-sm nums">{t("parts.count", { count: fit.count })}</p>
                {fit.quantity ? (
                  <p className="text-muted-foreground text-sm">
                    {t("parts.required", { count: fit.quantity })}
                  </p>
                ) : null}
                {fit.sourceUrl ? (
                  <a
                    href={fit.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${LINK} text-muted-foreground text-sm`}
                  >
                    {t("parts.source")}
                  </a>
                ) : null}
              </div>
              {deviceId ? <TakePart fit={fit} deviceId={deviceId} retired={retired} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PartModel({
  modelId,
  detail,
}: {
  modelId: string;
  detail: NonNullable<Awaited<ReturnType<typeof partDetail>>>;
}) {
  const t = useT();
  const fetcher = useFetcher<{ partsError?: string; partsSaved?: boolean }>();
  return (
    <section
      className="bg-card shadow-surface-2 min-w-0 rounded-lg p-4"
      aria-label={t("parts.stockAndFits")}
    >
      <h2 className="text-base font-semibold">{t("parts.stockAndFits")}</h2>
      <p className="my-3 text-base nums">{t("parts.count", { count: detail.count })}</p>
      <ul className="mb-4 space-y-2 text-sm">
        {detail.stock.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-wrap justify-between gap-2">
            <Link className={LINK} to={`/inventory/stock/${row.id}`}>
              {row.location?.name ?? row.name}
            </Link>
            <span className="nums">{row.quantity}</span>
          </li>
        ))}
      </ul>
      <fetcher.Form
        method="post"
        action={`/inventory/models/${modelId}`}
        aria-label={t("parts.addStock")}
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <Field name="quantity" className="flex flex-col gap-1">
          <FieldLabel className="text-sm">{t("parts.quantity")}</FieldLabel>
          <Input
            type="number"
            name="quantity"
            min={1}
            max={2147483647}
            step={1}
            required
            defaultValue="1"
            className={`${fieldClassName} h-control px-control w-32`}
          />
        </Field>
        <Button
          type="submit"
          className={CONTROL}
          name="_action"
          value="addPartStock"
          disabled={fetcher.state !== "idle"}
        >
          {t("parts.addStock")}
        </Button>
        <span role="status" className="w-full text-sm">
          {fetcher.data?.partsError ?? (fetcher.data?.partsSaved ? t("parts.stockAdded") : "")}
        </span>
      </fetcher.Form>
      <h3 className="mb-3 text-base font-semibold">{t("parts.fits")}</h3>
      {!detail.fits.length ? (
        <p className="text-muted-foreground text-sm">{t("parts.noFits")}</p>
      ) : (
        <ul className="divide-border divide-y">
          {detail.fits.map((fit) => (
            <li key={fit.id} className="min-w-0 py-3 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {fit.modelId ? (
                  <Link to={`/inventory/models/${fit.modelId}`} className={`${LINK} font-semibold`}>
                    {fit.manufacturer} {fit.name}
                  </Link>
                ) : (
                  <span className="min-w-0 break-words font-semibold">
                    {fit.manufacturer} {fit.name}
                  </span>
                )}
                {fit.sourceUrl ? (
                  <a
                    href={fit.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${LINK} text-muted-foreground text-sm`}
                  >
                    {t("parts.source")}
                  </a>
                ) : null}
              </div>
              {!fit.devices.length ? (
                <p className="text-muted-foreground mt-2 text-sm">{t("parts.noDevices")}</p>
              ) : (
                <table className="mt-2 w-full table-fixed text-sm">
                  <thead className="bg-card sticky top-0">
                    <tr className="text-muted-foreground text-start">
                      <th scope="col" className="pb-1 text-start font-normal">
                        {t("parts.device")}
                      </th>
                      <th scope="col" className="w-1/3 pb-1 text-start font-normal">
                        {t("parts.room")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fit.devices.map((device) => (
                      <tr key={device.id}>
                        <th scope="row" className="py-1 pe-4 text-start font-normal">
                          <Link
                            className="block truncate underline underline-offset-4"
                            title={device.name ?? device.assetTag ?? fit.name}
                            to={`/inventory/${device.id}`}
                          >
                            {device.name ?? device.assetTag ?? fit.name}
                          </Link>
                        </th>
                        <td className="py-1">
                          {device.room ? (
                            <Link
                              className="block truncate underline underline-offset-4"
                              title={device.room.name}
                              to={`/rooms/${device.room.slug}`}
                            >
                              {device.room.name}
                            </Link>
                          ) : (
                            t("parts.noRoom")
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function EditModelParts({
  modelId,
  fits,
  options,
}: {
  modelId: string;
  fits: Awaited<ReturnType<typeof modelParts>>;
  options: Awaited<ReturnType<typeof partModelOptions>>;
}) {
  const t = useT();
  const fetcher = useFetcher<{ partsError?: string; partsSaved?: boolean }>();
  return (
    <section
      className="bg-card shadow-surface-2 min-w-0 rounded-lg p-4"
      aria-label={t("parts.edit")}
    >
      <h2 className="mb-3 text-base font-semibold">{t("parts.edit")}</h2>
      <p className="text-muted-foreground mb-3 text-sm">{t("parts.editHelp")}</p>
      {options.length ? (
        <fetcher.Form
          method="post"
          action={`/inventory/models/${modelId}`}
          aria-label={t("parts.link")}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <Choice
              name="partModelId"
              label={t("parts.partModel")}
              items={options.map((part) => ({
                value: part.id,
                label: `${part.manufacturer ?? ""} ${part.name}`.trim(),
              }))}
            />
          </div>
          <Button
            type="submit"
            name="_action"
            value="addPartFit"
            className={CONTROL}
            disabled={fetcher.state !== "idle"}
          >
            {t("parts.link")}
          </Button>
        </fetcher.Form>
      ) : (
        <Link className={`${LINK} text-sm`} to="/inventory/models/new">
          {t("parts.createModel")}
        </Link>
      )}
      <p role="status" className="mt-2 text-sm">
        {fetcher.data?.partsError ?? (fetcher.data?.partsSaved ? t("parts.saved") : "")}
      </p>
      {fits
        .filter((fit) => !fit.catalogKey)
        .map((fit) => (
          <fetcher.Form
            key={fit.id}
            method="post"
            action={`/inventory/models/${modelId}`}
            aria-label={t("parts.removeNamed", { name: fit.part.name })}
            className="mt-3 flex flex-wrap items-center justify-between gap-2"
          >
            <span className="min-w-0 break-words text-sm">{fit.part.name}</span>
            <input type="hidden" name="partModelId" value={fit.part.id} />
            <Button
              type="submit"
              name="_action"
              value="removePartFit"
              className={CONTROL}
              disabled={fetcher.state !== "idle"}
            >
              {t("parts.removeNamed", { name: fit.part.name })}
            </Button>
          </fetcher.Form>
        ))}
    </section>
  );
}
