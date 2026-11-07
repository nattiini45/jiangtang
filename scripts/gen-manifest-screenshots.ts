/**
 * `pnpm exec tsx scripts/gen-manifest-screenshots.ts` — regenerates the PWA
 * manifest screenshots in public/shots/. They are branded placeholders built
 * from the same J mark as scripts/generate-icons.ts (replace them with real
 * captures once the mobile UI is final — see WORKSTATE.md). The brand tokens
 * are the dark-mode values from app/app.css: surface #171717, foreground
 * #ededed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const OUT = join(PUBLIC, "shots");

const SHOTS = [
  { file: "mobile-capture.png", w: 390, h: 844, label: "Capture" },
  { file: "mobile-tasks.png", w: 390, h: 844, label: "Tasks" },
  { file: "desktop-board.png", w: 1280, h: 720, label: "Board" },
] as const;

// The J mark from generate-icons.ts, drawn in a 512 viewBox, centered.
function svg({ w, h, label }: (typeof SHOTS)[number]) {
  const mark = Math.round(Math.min(w, h) * 0.34);
  const scale = mark / 512;
  const ox = Math.round(w / 2 - (512 * scale) / 2);
  const oy = Math.round(h / 2 - (512 * scale) / 2 - mark * 0.45);
  const font = Math.round(Math.min(w, h) * 0.045);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#171717"/>
  <g transform="translate(${ox} ${oy}) scale(${scale})">
    <path d="M352 100 V284 A96 96 0 0 1 160 284" fill="none" stroke="#ededed" stroke-width="64"/>
  </g>
  <text x="${w / 2}" y="${oy + mark * 1.55}" font-family="sans-serif" font-size="${font}" fill="#ededed" text-anchor="middle">${label} · Jiangtang</text>
</svg>`;
}

await mkdir(OUT, { recursive: true });
for (const shot of SHOTS) {
  const png = await sharp(Buffer.from(svg(shot)))
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT, shot.file), png);
  console.log(`shots/${shot.file} — ${shot.w}x${shot.h}, ${png.length} bytes`);
}
