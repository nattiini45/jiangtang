import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { format, resolveConfig } from "prettier";

const research = JSON.parse(await readFile(process.argv[2], "utf8"));
const catalog = JSON.parse(
  await readFile(new URL("../../app/lib/catalog/epson.json", import.meta.url), "utf8"),
);
const records = new Map();
const fits = [];
for (const row of research.records) {
  if (row.model.status !== "verified") continue;
  const model = catalog.records.find((record) => record.name === row.model.value);
  if (!model) continue;
  for (const [kind, facts] of [
    ["projector_lamp", row.lamps?.parts ?? []],
    ["projector_filter", row.filters ?? []],
  ]) {
    for (const fact of facts) {
      if (fact.status !== "verified" || !fact.value?.partNumber || !fact.sources?.length) continue;
      const name = fact.value.partNumber;
      const key = `epson-${name.toLowerCase()}`;
      const sources = fact.sources.map(({ url, retrievedOn }) => ({ url, retrievedOn }));
      const existing = records.get(key);
      if (existing && existing.kind !== kind) throw new Error(`Conflicting kind: ${key}`);
      if (existing)
        for (const source of sources) {
          if (!existing.sources.some((entry) => entry.url === source.url))
            existing.sources.push(source);
        }
      records.set(
        key,
        existing ?? {
          key,
          manufacturer: "Epson",
          name,
          aliases: [],
          partNumbers: [name],
          kind,
          productUrl: sources[0].url,
          manualUrl: null,
          values: { part_number: name },
          ports: [],
          sources,
        },
      );
      fits.push({
        modelKey: model.key,
        partKey: key,
        quantity: fact.value.quantity ?? null,
        sourceUrl: sources[0].url,
      });
    }
  }
}
const path = new URL("../../app/lib/catalog/parts.json", import.meta.url);
await writeFile(
  path,
  await format(JSON.stringify({ version: 1, records: [...records.values()], fits }), {
    ...(await resolveConfig(path.pathname)),
    parser: "json",
  }),
);
