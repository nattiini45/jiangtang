/**
 * `pnpm exec tsx scripts/generate-icons.ts` — regenerates
 * public/icon-192.png and public/icon-512.png from the SVG below. The icons
 * are reproducible from this file and carry no third-party artwork.
 *
 * The J is drawn geometrically: a 64px white stroke (flat cap) with a 96px
 * hook radius on the manifest's #0a0a0a square. Its extremes stay inside the
 * maskable 80% safe circle (radius 204.8px on the 512 viewBox).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const svg = (
  size: number,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <path d="M352 100 V284 A96 96 0 0 1 160 284" fill="none" stroke="#ffffff" stroke-width="64"/>
</svg>`;

for (const size of [192, 512]) {
  const png = await sharp(Buffer.from(svg(size)))
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(PUBLIC, `icon-${size}.png`), png);
  console.log(`icon-${size}.png — ${png.length} bytes`);
}
