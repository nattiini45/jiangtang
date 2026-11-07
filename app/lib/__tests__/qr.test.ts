import { describe, expect, it } from "vitest";
import { qrSvg } from "~/lib/qr.server";

/**
 * The QR encoder guard: the SVG is well-formed markup with a path, sized as
 * requested, and — the property that matters for a URL payload — the encoded
 * text's special characters are escaped so the SVG cannot be broken out of.
 */
describe("qrSvg", () => {
  it("renders an SVG with a path at the requested width", async () => {
    const svg = await qrSvg("https://jiangtang.local/quick-entry?roomId=abc123", 168);
    expect(svg).toMatch(/^<svg[^>]*>/);
    expect(svg).toContain("<path");
    expect(svg).toContain('width="168"');
    expect(svg).toContain("</svg>");
  });

  it("never emits markup from the payload — the code is path geometry, not text", async () => {
    const svg = await qrSvg('https://x.test/?q=<script>alert(1)</script>&a="b"');
    // The payload is encoded into the QR matrix, so it appears only as path
    // data — an injected tag must not survive as markup.
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("alert(1)");
    expect(svg).toMatch(/^<svg[^>]*>[\s\S]*<\/svg>\s*$/);
    expect(svg).toContain("<path");
  });

  it("different payloads produce different codes", async () => {
    const a = await qrSvg("https://x.test/rooms/a");
    const b = await qrSvg("https://x.test/rooms/b");
    expect(a).not.toBe(b);
  });
});
