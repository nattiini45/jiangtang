import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { format, resolveConfig } from "prettier";

const research = JSON.parse(await readFile(process.argv[2], "utf8"));
research.sources.trade_knowledge ??= { title: "General trade knowledge", url: null };
const path = new URL("../../app/lib/equipment-kinds/library.json", import.meta.url);
const library = JSON.parse(await readFile(path, "utf8"));
const types = {
  text: "TEXT",
  long_text: "LONG_TEXT",
  number: "NUMBER",
  yes_no: "BOOLEAN",
  choice: "CHOICE",
  multi_choice: "MULTI_CHOICE",
  date: "DATE",
  link: "LINK",
};
const projector = research.kinds.find((kind) => kind.key === "projector");
const shared = new Map(research.shared_properties.map((property) => [property.key, property]));
const properties = projector.properties.flatMap((reference) => {
  const property = reference.shared ? { ...shared.get(reference.key), ...reference } : reference;
  if (property.reading || !types[property.type]) return [];
  return [
    {
      key: reference.shared ? property.key : `projector.${property.key}`,
      de: property.de,
      en: property.en,
      type: types[property.type],
      unit: property.unit ?? null,
      options: property.options ?? [],
      level: property.level.toUpperCase(),
      nature: property.nature,
      weight: property.weight ?? "useful",
      appliesIf: property.applies_if
        ? {
            property: `projector.${property.applies_if.property}`,
            values: property.applies_if.values,
          }
        : null,
      help: { de: property.help_de ?? null, en: property.help_en ?? null },
      sources: [
        ...new Set([...(shared.get(reference.key)?.sources ?? []), ...(property.sources ?? [])]),
      ],
    },
  ];
});
const allSources = [...new Set(properties.flatMap((property) => property.sources))].sort();
const output = {
  version: research.version,
  units: research.units,
  institutionTypes: library.institutionTypes,
  functionGroups: library.functionGroups,
  sharedProperties: properties.filter((property) => !property.key.includes(".")),
  kinds: library.kinds.map(({ properties: _properties, ...kind }) => ({
    ...kind,
    ...(kind.key === "projector" ? { properties: properties.map((property) => property.key) } : {}),
  })),
  properties: properties.filter((property) => property.key.includes(".")),
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
