import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { format, resolveConfig } from "prettier";

const [sourcePath] = process.argv.slice(2);
if (!sourcePath)
  throw new Error("Usage: node scripts/library/room-types.mjs <preset-library.json>");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const target = new URL("../../app/lib/equipment-kinds/library.json", import.meta.url);
const library = JSON.parse(await readFile(target, "utf8"));
library.roomTypes = source.room_types.map((type, position) => ({
  key: type.key,
  de: type.de,
  en: type.en,
  position,
  functions: library.functions
    .filter((fn) => fn.carriers.some((key) => type.typical_device_kinds.includes(key)))
    .map((fn) => fn.key),
}));
await writeFile(
  target,
  await format(JSON.stringify(library), {
    ...(await resolveConfig(target.pathname)),
    parser: "json",
  }),
);
