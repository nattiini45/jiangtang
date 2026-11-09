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
  it("nests phone note headings below the page title without changing default previews", () => {
    const source = "# Title\n\n## Section\n\n<script>unsafe</script>";
    const nested = renderToStaticMarkup(
      createElement(MarkdownPreview, { source, nestedHeadings: true }),
    );
    expect(nested).not.toContain("<h1>");
    expect(nested).toContain("<h2>Title</h2>");
    expect(nested).toContain("<h3>Section</h3>");
    expect(nested).not.toContain("<script>");
    expect(renderToStaticMarkup(createElement(MarkdownPreview, { source }))).toContain(
      "<h1>Title</h1>",
    );
  });
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
