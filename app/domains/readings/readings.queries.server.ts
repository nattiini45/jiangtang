import { db, type Tx } from "~/lib/db.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { conditionHolds, valueObject } from "~/lib/custom-fields/fields";
import { libraryProperties } from "~/lib/equipment-kinds/properties";
import { availablePartStock } from "~/domains/inventory/inventory.parts.queries.server";
import { NotFoundError } from "~/lib/errors.server";
import { readingAge, readingDue, readingRules } from "./readings.policy";
import { currentLocale } from "~/i18n/request-locale.server";
import { utcToBerlinLocal } from "~/lib/time.server";
import { Prisma, type EquipmentReading } from "~/generated/prisma/client";
import { readConfig } from "~/lib/config.server";
import { planTitle } from "~/domains/plans/plans.queries.server";
import { tr } from "~/i18n/request-locale.server";

export function dueMargin() {
  return readConfig("READING_DUE_MARGIN_PERCENT");
}

export async function readingDevices(
  where: { id?: string; roomId?: string } = {},
  now = new Date(),
  tx: Tx = db,
) {
  const [devices, measures, fields] = await Promise.all([
    tx.equipment.findMany({
      where: { ...where, ...(where.id ? {} : { status: { not: "RETIRED" } }) },
      include: {
        kind: true,
        room: true,
        model: {
          include: {
            partFits: {
              include: {
                partModel: {
                  include: {
                    kind: true,
                    stock: {
                      where: availablePartStock,
                      select: {
                        id: true,
                        name: true,
                        quantity: true,
                        location: { select: { name: true } },
                      },
                      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    getFieldSchema("EQUIPMENT", { store: "READING" }, tx),
    getFieldSchema("EQUIPMENT", {}, tx),
  ]);
  const readings = devices.length
    ? await tx.$queryRaw<EquipmentReading[]>(Prisma.sql`
    SELECT DISTINCT ON ("equipmentId", "fieldId") * FROM "EquipmentReading"
    WHERE "equipmentId" IN (${Prisma.join(devices.map((device) => device.id))})
    ORDER BY "equipmentId", "fieldId", "observedAt" DESC, "createdAt" DESC, id DESC
  `)
    : [];
  return devices
    .map((device) => {
      const parts = (device.model?.partFits ?? []).map(({ partModel: part }) => ({
        id: part.id,
        name: [part.manufacturer, part.name].filter(Boolean).join(" "),
        kind: part.kind?.systemKey ?? null,
        values: part.customValues,
        count: part.stock.reduce((sum, row) => sum + row.quantity, 0),
        stock: part.stock,
      }));
      return {
        id: device.id,
        retired: device.status === "RETIRED",
        name:
          device.name ?? device.model?.name ?? device.kind?.name ?? device.assetTag ?? device.id,
        room: device.room
          ? { id: device.room.id, name: device.room.name, slug: device.room.slug }
          : null,
        now,
        localNow: utcToBerlinLocal(now, "millisecond"),
        parts: parts.map(({ values: _values, ...part }) => part),
        measures: measures
          .filter(
            (field) =>
              !field.hidden &&
              field.kinds.some((link) => link.kindId === device.kindId) &&
              conditionHolds(field, fields, device.customValues, device.model?.customValues),
          )
          .map((field) => {
            const latest =
              readings.find(
                (reading) => reading.equipmentId === device.id && reading.fieldId === field.id,
              ) ?? null;
            const rule = readingRules[field.libraryKey ?? ""];
            const compatible = parts.filter((part) => rule?.partKinds?.includes(part.kind ?? ""));
            const fitted = latest?.partModelId
              ? compatible.filter((part) => part.id === latest.partModelId)
              : compatible.length === 1
                ? compatible
                : [];
            const limits = (rule?.limits ?? []).flatMap((key) => {
              const definition = fields.find((field) => field.libraryKey === key);
              if (!definition) return [];
              if (
                !conditionHolds(definition, fields, device.customValues, device.model?.customValues)
              )
                return [];
              const own =
                valueObject(device.model?.customValues)[definition.id] ??
                valueObject(device.customValues)[definition.id];
              const values = [
                own,
                ...fitted.map((part) => valueObject(part.values)[definition.id]),
              ];
              return values.filter(
                (value): value is number => typeof value === "number" && value > 0,
              );
            });
            const limit = limits.length ? Math.min(...limits) : null;
            const age = latest ? readingAge(latest.observedAt, now) : null;
            const displayValue = latest?.value;
            return {
              id: field.id,
              key: field.libraryKey!,
              name: field.name,
              type: field.type,
              unit: field.unit?.label ?? null,
              options: field.options.map((option) => ({ value: option.id, label: option.label })),
              latest: latest
                ? {
                    ...latest,
                    display:
                      field.options.find((option) => option.id === displayValue)?.label ??
                      String(displayValue),
                  }
                : null,
              age,
              stale: age !== null && age > 365,
              serviceCounter: !!rule,
              limit,
              state: readingDue(latest?.value, limit, dueMargin()),
            };
          }),
      };
    })
    .filter((device) => where.id || device.measures.length);
}

export async function getDeviceReadings(id: string, history = false) {
  const device = (await readingDevices({ id }))[0];
  if (!device) throw new NotFoundError();
  const entries = history
    ? await db.equipmentReading.findMany({
        where: { equipmentId: id },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: {
          recordedBy: { select: { name: true } },
          field: { select: { name: true, systemKey: true } },
          plan: { select: { name: true, systemKey: true } },
        },
      })
    : [];
  return {
    device,
    history: entries.map((entry) => ({
      ...entry,
      name: entry.plan
        ? planTitle(entry.plan)
        : (libraryProperties.get(entry.field.systemKey ?? "")?.[currentLocale()] ??
          entry.field.name),
      display: entry.plan
        ? tr(entry.value === true ? "plans.passed" : "plans.failed")
        : (device.measures
            .find((measure) => measure.id === entry.fieldId)
            ?.options.find((option) => option.value === entry.value)?.label ?? String(entry.value)),
    })),
  };
}

export async function dueReadings(now = new Date()) {
  return (await readingDevices({}, now))
    .flatMap((device) =>
      device.measures
        .filter((measure) => measure.state === "due" || measure.state === "soon")
        .map((measure) => ({
          deviceId: device.id,
          device: device.name,
          room: device.room,
          parts: device.parts,
          ...measure,
        })),
    )
    .sort(
      (a, b) =>
        Number(b.stale) - Number(a.stale) ||
        Number(b.latest!.value) / b.limit! - Number(a.latest!.value) / a.limit! ||
        +a.latest!.observedAt - +b.latest!.observedAt ||
        a.id.localeCompare(b.id),
    );
}

export type ReadingDevice = Awaited<ReturnType<typeof readingDevices>>[number];
