import { readFile, writeFile, mkdir } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { format, resolveConfig } from "prettier";

const input = process.argv[2];
const read = async (name) => JSON.parse(await readFile(`${input}/${name}.json`, "utf8"));
const [models, specs, checked, remaining, control] = await Promise.all(
  ["epson-models", "epson-specs", "epson-checked", "epson-ports", "epson-control"].map(read),
);
const portsByName = new Map([...checked, ...remaining.records].map((row) => [row.model, row]));
let omitted = 0;
const records = models.records.map((row) => {
  const sources = new Map();
  const cite = (entries = [], date = models.asOf) => {
    for (const entry of entries)
      if (entry.url)
        sources.set(entry.url, { url: entry.url, retrievedOn: entry.retrievedOn ?? date });
  };
  const fact = (entry) => {
    if (entry?.status !== "verified") return undefined;
    cite(entry.sources);
    return entry.value ?? undefined;
  };
  const values = {};
  const put = (key, value) => {
    if (value !== undefined && value !== null && value !== "") values[key] = value;
  };
  const model = fact(row.model);
  const page = specs.pages.find((page) => page.model === model);
  const normal = (entries) =>
    entries?.find(
      (entry) => entry.status === "verified" && ["normal", "high"].includes(entry.value?.mode),
    );
  const light = fact(row.imaging.lightSource);
  put("projector.light_source", light?.toLowerCase());
  put(
    "projector.imaging",
    { "3LCD": "3lcd", "1DLP": "dlp_single", "3DLP": "dlp_three", LCoS: "lcos" }[
      fact(row.imaging.technology)
    ],
  );
  const resolution = fact(row.imaging.nativeResolution);
  if (resolution) put("projector.resolution", `${resolution.widthPx} × ${resolution.heightPx}`);
  put("projector.resolution_enhancement", fact(row.imaging.pixelShifting));
  put("projector.interchangeable_lens", fact(row.optics.interchangeable));
  const lens = fact(
    row.optics.lensConfigurations?.find((entry) => entry.value?.role === "standard"),
  );
  put("projector.lens_shift_h", lens?.shiftHorizontalMaxPercent);
  put("projector.lens_shift_v", lens?.shiftVerticalMaxPercent);
  const brightness = page?.specs.find((spec) => spec.label === "White Light Output");
  const colour = page?.specs.find((spec) => spec.label === "Color Light Output");
  const lightOutput = (spec) => {
    const values = spec?.parsed.filter((value) => value.unit === "lm") ?? [];
    return (
      values.find((value) => value.condition === "normal") ??
      (values.length === 1 && values[0].condition == null ? values[0] : undefined)
    );
  };
  const whiteNormal = lightOutput(brightness);
  const colourNormal = lightOutput(colour);
  if (whiteNormal || colourNormal) cite([{ url: page.finalUrl, retrievedOn: page.retrievedOn }]);
  put("projector.brightness", whiteNormal?.value);
  put("projector.colour_light_output", colourNormal?.value);
  if (whiteNormal?.standard?.includes("ISO 21118"))
    put("projector.brightness_standard", "iso_21118");
  put("projector.lamp_count", fact(row.lamps.count));
  put("projector.lamp_life_normal", fact(normal(row.lamps.ratedLife))?.hours);
  put(
    "projector.lamp_life_eco",
    fact(row.lamps.ratedLife?.find((entry) => ["eco", "economy"].includes(entry.value?.mode)))
      ?.hours,
  );
  const life = fact(normal(row.laserOrLedLife));
  put("projector.light_source_life", life?.hours);
  put("projector.life_conditions", life?.conditions);
  put("projector.noise", fact(normal(row.physical.noise))?.dBA);
  put("weight", fact(row.physical.weightKg));
  const dimensions = fact(row.physical.dimensionsMm);
  for (const axis of ["width", "height", "depth"])
    put(`projector.body_${axis}`, dimensions?.[axis]);
  put(
    "power_consumption",
    fact(
      row.power.find(
        (entry) =>
          entry.status === "verified" &&
          entry.value?.mode === "normal" &&
          entry.value?.powerKind === "on_mode",
      ),
    )?.watts,
  );
  put("datasheet", fact(row.urls.datasheet));
  const controls = control.models.find((entry) => entry.id === row.id);
  for (const key of ["control_protocols", "control_systems"]) {
    const entries = controls?.[key] ?? [];
    if (entries.length)
      put(
        `projector.${key}`,
        entries.map((entry) => entry.key),
      );
    for (const entry of entries) cite(entry.sources, control.asOf);
  }
  const portRecord = portsByName.get(model);
  if (!portRecord) throw new Error(`Missing ports for ${model}`);
  cite([portRecord.source]);
  const ports = portRecord.ports.flatMap((port) => {
    if (
      port.connectorNote?.toLowerCase().startsWith("assumed") &&
      !/\b(?:RS-232C|Ethernet|LAN|HDBaseT)\b/i.test(`${port.label} ${port.connectorNote}`)
    ) {
      omitted++;
      return [];
    }
    return [
      {
        label: port.label,
        connector: port.connector,
        direction: port.direction,
        signal: port.signal,
      },
    ];
  });
  return {
    key: row.id,
    manufacturer: fact(row.manufacturer),
    name: model,
    aliases: fact(row.aliases) ?? [],
    partNumbers: fact(row.manufacturerPartNumbers) ?? [],
    kind: "projector",
    productUrl: fact(row.urls.productPage),
    manualUrl: fact(row.urls.manual) ?? null,
    values,
    ports,
    sources: [...sources.values()].sort((a, b) => a.url.localeCompare(b.url)),
  };
});
const output = new URL("../../app/lib/catalog/epson.json", import.meta.url);
await mkdir(new URL("../../app/lib/catalog/", import.meta.url), { recursive: true });
await writeFile(
  output,
  await format(JSON.stringify({ version: 1, records }), {
    ...(await resolveConfig(output.pathname)),
    parser: "json",
  }),
);
process.stdout.write(`${records.length} records; ${omitted} assumed-connector port rows omitted\n`);
