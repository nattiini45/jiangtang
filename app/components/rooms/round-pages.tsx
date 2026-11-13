import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Check } from "lucide-react";
import { useT } from "~/i18n/use-t";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { ViewSwitch } from "~/components/layout/view-switch";
import type { getRound, listRounds, roundTargets } from "~/domains/functions/rounds.queries.server";

export function roundPageMeta({
  data,
  matches,
}: {
  data?: unknown;
  matches: Parameters<typeof metaLocale>[0];
}) {
  const locale = metaLocale(matches);
  if (data && typeof data === "object")
    for (const key of ["room", "round"]) {
      const target: unknown = Reflect.get(data, key);
      if (target && typeof target === "object" && typeof Reflect.get(target, "name") === "string")
        return [
          {
            title: t(locale, key === "room" ? "functions.rounds.checkMeta" : "rooms.meta.detail", {
              name: Reflect.get(target, "name"),
            }),
          },
        ];
    }
  return [{ title: t(locale, "rooms.meta.detail", { name: t(locale, "functions.rounds.title") }) }];
}

export function RoundChoice({
  name,
  value,
  children,
  defaultChecked,
}: {
  name: string;
  value: string;
  children: React.ReactNode;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-sm">
      <Checkbox
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm shadow-[inset_0_0_0_1px_var(--input)] data-checked:bg-selected"
      >
        <CheckboxIndicator>
          <Check className="size-4" aria-hidden />
        </CheckboxIndicator>
      </Checkbox>
      <span className="min-w-0 break-words">{children}</span>
    </label>
  );
}

export function RoundIndex({
  rooms,
  rounds,
  defaultName,
  mobile = false,
  error,
}: {
  rooms: Awaited<ReturnType<typeof roundTargets>>;
  rounds: Awaited<ReturnType<typeof listRounds>>;
  defaultName: string;
  mobile?: boolean;
  error?: string;
}) {
  const t = useT();
  const navigation = useNavigation();
  const [building, setBuilding] = useState("");
  const [selected, setSelected] = useState(() => new Set(rooms.map((room) => room.id)));
  const prefix = mobile ? "/m" : "";
  return (
    <div className={`flex min-w-0 flex-col gap-6 ${mobile ? "p-4" : ""}`}>
      <h1 className="text-xl font-bold">{t("functions.rounds.title")}</h1>
      {rounds.length ? (
        <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
          {rounds.map((round) => (
            <li
              key={round.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-3"
            >
              <Link
                className="min-w-0 flex-1 truncate font-semibold underline underline-offset-4"
                title={round.name}
                to={`${prefix}/rounds/${round.id}`}
              >
                {round.name}
              </Link>
              <span className="text-sm text-muted-foreground nums">
                {t("functions.rounds.progress", {
                  done: round.rooms.filter((room) => room.completedAt).length,
                  total: round.rooms.length,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("functions.rounds.empty")}</p>
      )}
      <Form
        method="post"
        aria-labelledby="round-start-title"
        className="flex min-w-0 flex-col gap-3"
      >
        <h2 id="round-start-title" className="text-base font-semibold">
          {t("functions.rounds.start")}
        </h2>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t("functions.rounds.name")}
          <Input
            name="name"
            defaultValue={defaultName}
            required
            maxLength={200}
            className={`${fieldClassName} min-h-11 px-3`}
          />
        </label>
        <p className="text-sm text-muted-foreground">{t("functions.rounds.scopeHelp")}</p>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t("functions.list.building")}
          <Select
            value={building}
            onChange={(event) => {
              const value = event.target.value;
              setBuilding(value);
              setSelected(
                new Set(
                  rooms
                    .filter((room) => !value || room.buildingName === value)
                    .map((room) => room.id),
                ),
              );
            }}
            className="[&>select]:min-h-11"
          >
            <option value="">{t("functions.list.allBuildings")}</option>
            {[...new Set(rooms.map((room) => room.buildingName).filter(Boolean))].map((name) => (
              <option key={name} value={name!}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            className={buttonVariants({ variant: "secondary" })}
            onClick={() =>
              setSelected(
                new Set(
                  rooms
                    .filter((room) => !building || room.buildingName === building)
                    .map((room) => room.id),
                ),
              )
            }
          >
            {t("functions.rounds.all")}
          </Button>
          <Button
            className={buttonVariants({ variant: "tertiary" })}
            onClick={() => setSelected(new Set())}
          >
            {t("functions.rounds.none")}
          </Button>
        </div>
        <fieldset className="bg-card shadow-surface-2 max-h-80 overflow-y-auto rounded-lg p-3">
          <legend className="text-sm font-semibold">{t("functions.rounds.scope")}</legend>
          {rooms
            .filter((room) => !building || room.buildingName === building)
            .map((room) => (
              <label
                key={room.id}
                className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={selected.has(room.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(room.id);
                      else next.delete(room.id);
                      return next;
                    })
                  }
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm shadow-[inset_0_0_0_1px_var(--input)] data-checked:bg-selected"
                >
                  <CheckboxIndicator>
                    <Check className="size-4" aria-hidden />
                  </CheckboxIndicator>
                </Checkbox>
                <span className="min-w-0 flex-1 truncate" title={room.name}>
                  {room.name}
                </span>
                <span className="text-muted-foreground">{room.buildingName}</span>
              </label>
            ))}
        </fieldset>
        {[...selected].map((id) => (
          <input key={id} type="hidden" name="roomIds" value={id} />
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={!selected.size || navigation.state !== "idle"}
          className={`${buttonVariants()} min-h-11 self-start`}
        >
          {t("functions.rounds.start")}
        </Button>
      </Form>
    </div>
  );
}

export function RoundProgress({
  round,
  mobile = false,
}: {
  round: NonNullable<Awaited<ReturnType<typeof getRound>>>;
  mobile?: boolean;
}) {
  const t = useT();
  const next = round.rooms.find((room) => !room.completedAt);
  return (
    <div className={`flex min-w-0 flex-col gap-5 ${mobile ? "p-4" : ""}`}>
      <Link to={mobile ? "/m/rounds" : "/rounds"} className="text-sm underline underline-offset-4">
        {t("functions.rounds.title")}
      </Link>
      <h1 className="break-words text-xl font-bold">{round.name}</h1>
      <p className="text-sm nums">
        {t("functions.rounds.progress", { done: round.done, total: round.rooms.length })}
      </p>
      {next ? (
        mobile ? (
          <Link
            className={`${buttonVariants()} min-h-11 self-start`}
            to={`/m/rounds/${round.id}/${next.roomId}`}
          >
            {t("functions.rounds.next")}
          </Link>
        ) : (
          <ViewSwitch
            view="mobile"
            next={`/m/rounds/${round.id}/${next.roomId}`}
            className={buttonVariants()}
          >
            {t("functions.rounds.check")}
          </ViewSwitch>
        )
      ) : (
        <p>{t("functions.rounds.finished")}</p>
      )}
      <section aria-labelledby="round-faults-title">
        <h2 id="round-faults-title" className="mb-3 text-base font-semibold">
          {t("functions.rounds.faults")}
        </h2>
        {round.faults.length ? (
          <ul className="space-y-3">
            {round.faults.map((fault) => (
              <li key={fault.id}>
                <Link
                  className="text-sm underline underline-offset-4"
                  to={`${mobile ? "/m" : ""}/tickets/${fault.id}`}
                >
                  {fault.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("functions.rounds.noFaults")}</p>
        )}
      </section>
      <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
        {round.rooms.map((row) => (
          <li key={row.roomId} className="flex min-w-0 items-center gap-3 p-3 text-sm">
            <span className="text-muted-foreground nums">{row.room.roomNumber}</span>
            <Link
              to={mobile ? `/m/rounds/${round.id}/${row.roomId}` : `/rooms/${row.room.slug}`}
              title={row.room.name}
              className="min-w-0 flex-1 truncate font-semibold underline underline-offset-4"
            >
              {row.room.name}
            </Link>
            <span className="hidden text-muted-foreground sm:inline">
              {row.room.building?.name}
            </span>
            <span>{t(row.completedAt ? "functions.rounds.done" : "functions.rounds.open")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
