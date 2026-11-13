import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { format, resolveConfig } from "prettier";

const research = JSON.parse(await readFile(process.argv[2], "utf8"));
research.sources.trade_knowledge ??= { title: "General trade knowledge", url: null };
const path = new URL("../../app/lib/equipment-kinds/library.json", import.meta.url);
const library = JSON.parse(await readFile(path, "utf8"));
const kinds = library.kinds.filter((kind) => kind.key !== "audio_equipment");
const audio = research.kinds.find((kind) => kind.key === "audio_equipment");
const partKeys = new Set([
  ...research.kinds.filter((kind) => kind.mapping === "part").map((kind) => kind.key),
  "projector_lamp",
  "projector_filter",
  "projector_lens",
  "wireless_battery",
  "battery_stock",
  "lamp_stock",
  "filter_stock",
  "remote",
]);
for (const source of research.kinds.filter((kind) => partKeys.has(kind.key))) {
  if (kinds.some((kind) => kind.key === source.key)) continue;
  kinds.push({
    key: source.key,
    de: source.de,
    en: source.en,
    group: source.group,
    institution_types: Object.keys(source.tier),
    tier: "special",
  });
}
if (!audio) throw new Error("Missing researched kind: audio_equipment");
kinds.splice(
  kinds.findIndex((kind) => kind.group === audio.group),
  0,
  {
    key: audio.key,
    de: audio.de,
    en: audio.en,
    group: audio.group,
    institution_types: Object.keys(audio.tier),
    tier: "core",
  },
);
const types = {
  text: "TEXT",
  long_text: "LONG_TEXT",
  number: "NUMBER",
  yes_no: "BOOLEAN",
  choice: "CHOICE",
  multi_choice: "MULTI_CHOICE",
  date: "DATE",
  link: "LINK",
  range: "RANGE",
};
const projector = research.kinds.find((kind) => kind.key === "projector");
const groups = [...library.functionGroups];
for (const key of new Set(kinds.map((kind) => kind.group))) {
  if (groups.some((group) => group.key === key)) continue;
  const source = research.function_groups.find((group) => group.key === key);
  if (!source) throw new Error(`Missing function group: ${key}`);
  groups.push({ key, de: source.de, en: source.en, position: source.position });
}
const shared = new Map(research.shared_properties.map((property) => [property.key, property]));
const propertiesByKind = new Map(
  kinds.map((kind) => {
    const source = research.kinds.find((entry) => entry.key === kind.key);
    if (!source) throw new Error(`Missing researched kind: ${kind.key}`);
    const references = [...source.properties];
    const legacy =
      kind.key === "microphone"
        ? ["frequency", "band_variant", "channel_name", "colour"]
        : kind.key === "control_processor"
          ? ["colour"]
          : [];
    for (const key of legacy)
      if (!references.some((reference) => reference.key === key))
        references.push({ key, shared: true });
    return [
      kind.key,
      references.flatMap((reference) => {
        const property = reference.shared
          ? {
              ...shared.get(reference.key),
              ...reference,
              applies_if: shared.get(reference.key).applies_if,
            }
          : reference;
        if (!types[property.type]) return [];
        const protocol = ["control_protocol", "control_api"].includes(property.key)
          ? projector.properties.find((property) => property.key === "control_protocols")
          : null;
        return [
          {
            key: reference.shared ? property.key : `${kind.key}.${property.key}`,
            de: protocol?.de ?? property.de,
            en: protocol?.en ?? property.en,
            type: types[property.type],
            unit: property.unit ?? null,
            options: property.options ?? [],
            level: property.level.toUpperCase(),
            nature: property.nature,
            ...(property.reading ? { store: "READING" } : {}),
            weight: property.weight ?? "useful",
            appliesIf: property.applies_if
              ? {
                  property: shared.has(property.applies_if.property)
                    ? property.applies_if.property
                    : `${kind.key}.${property.applies_if.property}`,
                  values: property.applies_if.values,
                }
              : null,
            help: { de: property.help_de ?? null, en: property.help_en ?? null },
            sources: [
              ...new Set([
                ...(shared.get(reference.key)?.sources ?? []),
                ...(property.sources ?? []),
              ]),
            ],
          },
        ];
      }),
    ];
  }),
);
const unique = new Map();
for (const kind of ["projector_filter", "filter_stock"]) {
  propertiesByKind.get(kind).push({
    key: `${kind}.service_interval`,
    de: "Wechselintervall (Betriebsstunden)",
    en: "Replacement interval (operating hours)",
    type: "NUMBER",
    unit: "h",
    options: [],
    level: "MODEL",
    nature: "specification",
    weight: "useful",
    appliesIf: null,
    help: {
      de: "Nach Herstellerangabe eintragen. Ohne Angabe wird keine Fälligkeit berechnet.",
      en: "Enter the manufacturer's interval. No due state is calculated without a value.",
    },
    sources: [],
  });
}
for (const property of [...propertiesByKind.values()].flat()) {
  const previous = unique.get(property.key);
  if (previous) {
    const { sources: _beforeSources, ...before } = previous;
    const { sources: _afterSources, ...after } = property;
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(`Conflicting shared property: ${property.key}`);
  }
  unique.set(property.key, {
    ...property,
    sources: [...new Set([...(previous?.sources ?? []), ...property.sources])],
  });
}
const properties = [...unique.values()];
const allSources = [...new Set(properties.flatMap((property) => property.sources))].sort();
const output = {
  version: Math.max(6, research.version),
  partKinds: [...partKeys],
  units: research.units.map((unit) =>
    unit.key === ":1" ? { ...unit, de: ": 1", en: ": 1" } : unit,
  ),
  institutionTypes: library.institutionTypes,
  functionGroups: groups,
  sharedProperties: properties.filter((property) => !property.key.includes(".")),
  kinds: kinds.map(({ properties: _properties, ...kind }) => ({
    ...kind,
    properties: propertiesByKind.get(kind.key).map((property) => property.key),
  })),
  properties: properties.filter((property) => property.key.includes(".")),
  functions: library.functions,
  roomTypes: library.roomTypes,
};
const formatting = { ...(await resolveConfig(path.pathname)), parser: "json" };
await writeFile(path, await format(JSON.stringify(output), formatting));
await writeFile(
  new URL("../../app/lib/equipment-kinds/library-sources.json", import.meta.url),
  await format(
    JSON.stringify(
      Object.fromEntries(
        allSources.map((key) => {
          if (!research.sources[key]) throw new Error(`Missing source: ${key}`);
          return [key, research.sources[key]];
        }),
      ),
    ),
    formatting,
  ),
);
