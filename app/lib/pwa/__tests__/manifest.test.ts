import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `.webmanifest` isn't a TS-recognized JSON module, so read + parse it at runtime.
const HERE = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(join(HERE, "..", "..", "..", "..", "public", "manifest.webmanifest"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  name: string;
  short_name: string;
  description: string;
  display: string;
  scope: string;
  start_url: string;
  lang?: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  screenshots: Array<{
    src: string;
    sizes: string;
    type: string;
    form_factor: string;
    label: string;
  }>;
  shortcuts: Array<{
    name: string;
    short_name: string;
    url: string;
    icons: Array<{ src: string; sizes: string; type: string }>;
  }>;
};

const iconFile = (src: string) => resolve(dirname(manifestPath), src.replace(/^\//, ""));

/**
 * PWA manifest shape. Asserts the installability criteria
 * (Chrome's PWA checklist): name, icons with 192+512, display standalone, scope
 * matching the /m surface.
 */
describe("PWA manifest", () => {
  it("declares a standalone display mode scoped to /m", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/m/");
    expect(manifest.start_url).toBe("/m/");
    // The static manifest declares a fixed document language; the app UI itself
    // follows the locale cookie / Accept-Language at runtime.
    expect(manifest.lang).toBe("en");
  });

  it("has the required 192 + 512 icons", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    const maskable = manifest.icons.find((i) => i.sizes === "512x512");
    expect(maskable?.purpose).toContain("maskable");
  });

  it("references icon files whose PNG dimensions match their declared sizes", () => {
    for (const icon of manifest.icons) {
      const png = readFileSync(iconFile(icon.src));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });

  it("declares screenshots and shortcuts whose files exist and match their declared sizes", () => {
    for (const shot of manifest.screenshots) {
      const png = readFileSync(iconFile(shot.src));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(shot.sizes);
    }
    for (const shortcut of manifest.shortcuts) {
      // Shortcuts must stay inside the /m scope, or the installed app opens outside itself.
      expect(shortcut.url.startsWith(manifest.scope)).toBe(true);
      for (const icon of shortcut.icons) {
        expect(readFileSync(iconFile(icon.src)).subarray(0, 8).toString("hex")).toBe(
          "89504e470d0a1a0a",
        );
      }
    }
  });

  it("carries a name + theme color", () => {
    expect(manifest.name).toBe("Jiangtang");
    expect(manifest.short_name).toBe("Jiangtang");
    expect(manifest.description).toBe(
      "The all-in-one workspace for AV and facilities teams: rooms, equipment, events, tickets, tasks and notes.",
    );
    expect(manifest.theme_color).toMatch(/^#/);
    expect(manifest.background_color).toMatch(/^#/);
  });
});
