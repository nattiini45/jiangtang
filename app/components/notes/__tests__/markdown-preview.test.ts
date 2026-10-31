import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "~/components/notes/markdown-preview";

/**
 * The XSS contract. `react-markdown` WITHOUT `rehype-raw` renders raw
 * HTML in a note body as literal text: `<script>` and `<img onerror>` must
 * never become elements. `renderToStaticMarkup` runs the real component
 * server-side — no DOM needed.
 */
describe("MarkdownPreview", () => {
  it("renders raw HTML in the body as escaped text, never as elements", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        source: "safe <script>alert(1)</script> mid <img src=x onerror=alert(1)> end",
      }),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("renders markdown — headings, gfm tables, task lists", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, { source: "# Titel\n\n- [ ] offen\n\n| a |\n| - |\n| b |" }),
    );
    expect(html).toContain("<h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });
});
