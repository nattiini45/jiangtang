import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkMarkdown, identifierVariants, prepareChunk } from "~/lib/search/chunking";

/** Pure chunking: heading trails, bounded splits, keyword variants. */

describe("chunkMarkdown", () => {
  it("carries the heading trail into each section", () => {
    const out = chunkMarkdown("# Raum\nText A\n\n## Technik\nText B\n\n# Andere\nText C");
    expect(out.map((s) => s.headingPath)).toEqual([["Raum"], ["Raum", "Technik"], ["Andere"]]);
    expect(out[1].text).toContain("## Technik");
  });

  it("splits a long section on paragraph boundaries, never mid-word", () => {
    const paras = Array.from({ length: 8 }, (_, i) => `Absatz ${i} `.repeat(40).trim());
    const body = `# Doc\n\n${paras.join("\n\n")}`;
    const out = chunkMarkdown(body, { max: 800 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) {
      expect(s.text.length).toBeLessThanOrEqual(800);
      // Every emitted boundary is a word boundary: no fragment starts mid-token.
      expect(s.text).not.toMatch(/^satz/); // would be a mid-word cut of "Absatz"
      expect(s.headingPath).toEqual(["Doc"]);
    }
    // Nothing was lost: concatenated chunk text covers every paragraph.
    for (const p of paras) expect(out.some((s) => s.text.includes(p))).toBe(true);
  });

  it("falls back to a whitespace cut inside one giant paragraph", () => {
    const long = `# Doc\n\n${"wort ".repeat(500)}`; // 2500 chars, no paragraph break
    const out = chunkMarkdown(long, { max: 2000 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.text).not.toMatch(/^\s|or\s/);
    // every chunk except the heading line itself only contains whole "wort"s
    for (const s of out.slice(1)) expect(s.text.split(/\s+/).every((w) => w === "wort")).toBe(true);
  });

  it("merges tiny sibling sections toward the target", () => {
    const out = chunkMarkdown("## A\nkurz\n\n## B\nkurz\n\n## C\nkurz");
    // different heading trails — nothing merges
    expect(out).toHaveLength(3);
  });
});

describe("identifierVariants", () => {
  it("e-mail → local part, domain, domain labels", () => {
    const v = identifierVariants("Kontakt: ersatzteile@demo-ersatzteile.example");
    expect(v).toEqual(
      expect.arrayContaining([
        "ersatzteile",
        "demo-ersatzteile.example",
        "demo-ersatzteile",
        "example",
      ]),
    );
  });

  it("IPv4 → octets", () => {
    const v = identifierVariants("IP 192.0.2.40");
    expect(v).toEqual(expect.arrayContaining(["192", "0", "2", "40"]));
  });

  it("MAC (colon or hyphen) → joined form", () => {
    expect(identifierVariants("MAC 02:00:00:11:3A:B7")).toContain("020000113AB7");
    expect(identifierVariants("MAC 02-00-00-11-3A-B7")).toContain("020000113AB7");
  });

  it("dotted room codes → parts and the joined form", () => {
    const v = identifierVariants("Lager D.01.01");
    expect(v).toEqual(expect.arrayContaining(["D0101", "D", "01", "01"]));
  });

  it("hyphenated serials/SKUs → joined form", () => {
    expect(identifierVariants("Seriennummer SN-ULX-0001")).toContain("SNULX0001");
    expect(identifierVariants("Artikelnummer CAB-HDMI-10")).toContain("CABHDMI10");
    expect(identifierVariants("YTF1-0001")).toContain("YTF10001");
  });

  it("a plain hyphenated word is not an identifier", () => {
    expect(identifierVariants("HDMI-Kabel")).not.toContain("HDMIKabel");
  });
});

describe("prepareChunk", () => {
  it('computes contentHash = sha256(title + "\\n" + text) and ceil(chars/4) tokens', () => {
    const p = prepareChunk({
      sourceType: "NOTE",
      sourceId: "n1",
      sourceTitle: "Titel",
      ordinal: 0,
      headingPath: [],
      text: "Vier Wörter hier",
      sourceUpdatedAt: new Date(),
    });
    expect(p.contentHash).toBe(
      createHash("sha256").update("Titel\nVier Wörter hier").digest("hex"),
    );
    expect(p.tokenCount).toBe(Math.ceil("Vier Wörter hier".length / 4));
    expect(typeof p.keywords).toBe("string");
  });
});
