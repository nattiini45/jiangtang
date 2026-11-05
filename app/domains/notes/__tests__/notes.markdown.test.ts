import { describe, expect, it } from "vitest";
import {
  draftToMarkdown,
  noteToMarkdown,
  parseMarkdownNote,
  type MarkdownNote,
} from "~/domains/notes/notes.markdown";

/**
 * The markdown contract. `parse(export(note))` must reproduce title,
 * body, tags, pinned, project byte-for-byte — even for the hostile bodies:
 * `---` lines, code fences, leading/trailing blank lines, umlauts, CRLF.
 */

const NOW = new Date("2026-10-08T10:00:00.000Z");

function note(over: Partial<MarkdownNote>): MarkdownNote {
  return {
    id: "cnote1",
    title: "Titel",
    body: "Inhalt",
    tags: ["a", "b"],
    pinned: true,
    project: { slug: "proj-1" },
    locationId: "cloc1",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function roundTrip(n: MarkdownNote) {
  return parseMarkdownNote("export.md", noteToMarkdown(n));
}

describe("markdown round-trip", () => {
  it("reproduces a plain note byte-for-byte", () => {
    const n = note({});
    const parsed = roundTrip(n);
    expect(parsed.title).toBe("Titel");
    expect(parsed.body).toBe("Inhalt");
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.pinned).toBe(true);
    expect(parsed.projectSlug).toBe("proj-1");
    expect(parsed.locationId).toBe("cloc1");
    expect(parsed.id).toBe("cnote1");
  });

  it("keeps a body that contains a `---` line (thematic break is not a fence)", () => {
    const body = "oben\n\n---\n\nunten";
    const parsed = roundTrip(note({ body }));
    expect(parsed.body).toBe(body);
  });

  it("keeps leading and trailing blank lines in the body", () => {
    const body = "\n\n\nleerzeichen\n\n";
    const parsed = roundTrip(note({ body }));
    expect(parsed.body).toBe(body);
  });

  it("keeps an empty body empty", () => {
    expect(roundTrip(note({ body: "" })).body).toBe("");
  });

  it("keeps code fences, umlauts and yaml-hostile titles", () => {
    const body = "```js\nconsole.log('---');\n```\nÄÖÜß — \"quoted\"";
    const n = note({ body, title: 'Titel: mit # Dingen — "ja"' });
    const parsed = roundTrip(n);
    expect(parsed.body).toBe(body);
    expect(parsed.title).toBe('Titel: mit # Dingen — "ja"');
  });

  it("omits unset project/location and still round-trips", () => {
    const parsed = roundTrip(note({ project: null, locationId: null, tags: [], pinned: false }));
    expect(parsed.projectSlug).toBeUndefined();
    expect(parsed.locationId).toBeUndefined();
    expect(parsed.tags).toEqual([]);
    expect(parsed.pinned).toBe(false);
  });
});

describe("parseMarkdownNote", () => {
  it("normalises CRLF line endings", () => {
    const parsed = parseMarkdownNote("x.md", "---\r\ntitle: T\r\n---\r\n\r\nzeile1\r\nzeile2\r\n");
    expect(parsed.title).toBe("T");
    expect(parsed.body).toBe("zeile1\nzeile2\n");
  });

  it("accepts tags as a comma string, not only a YAML list", () => {
    const parsed = parseMarkdownNote("x.md", "---\ntags: a, b ,c\n---\n\nx");
    expect(parsed.tags).toEqual(["a", "b", "c"]);
  });

  it("falls back to the first `# ` heading for the title", () => {
    const parsed = parseMarkdownNote("x.md", "Einleitung\n\n# Aus der Überschrift\n\nText");
    expect(parsed.title).toBe("Aus der Überschrift");
    expect(parsed.body).toContain("# Aus der Überschrift"); // body stays verbatim
  });

  it("falls back to the filename (sans .md) when nothing else names it", () => {
    const parsed = parseMarkdownNote("Meeting-Notizen.md", "nur text");
    expect(parsed.title).toBe("Meeting-Notizen");
    expect(parsed.body).toBe("nur text");
  });

  it("treats text without a closing fence as plain body", () => {
    const parsed = parseMarkdownNote("x.md", "---\ntitle: nie geschlossen\nkein ende");
    expect(parsed.title).toBe("x");
    expect(parsed.body).toContain("title: nie geschlossen");
  });
});

describe("draftToMarkdown", () => {
  it("round-trips an unsaved draft through the importer, without an id", () => {
    const draft = {
      title: "Entwurf: Bühne",
      body: "---\nkein Front-Matter\n\n```\ncode\n```\n",
      tags: ["licht", "ton"],
      pinned: true,
      projectSlug: "sommerfest",
      locationId: "loc12345",
    };
    const parsed = parseMarkdownNote("entwurf.md", draftToMarkdown(draft));
    expect(parsed).toEqual({
      id: undefined,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      pinned: true,
      projectSlug: "sommerfest",
      locationId: "loc12345",
    });
  });

  it("omits project and location when unset", () => {
    const md = draftToMarkdown({ title: "x", body: "y", tags: [], pinned: false });
    expect(md).not.toMatch(/project:|location:|id:/);
  });
});
