import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rendered markdown for `/notes/:id`. **Deliberately no `rehype-raw`**:
 * raw HTML in a note (`<script>`, `<img onerror=…>`) renders as literal text —
 * measured: react-markdown drops the `html` nodes into escaped text nodes when
 * `allowDangerousHtml` stays off. `remark-gfm` covers tables, task lists and
 * strikethrough — the checklist the `/` row can insert.
 *
 * The `[&_*]` selectors are the app's typography stand-in (no typography
 * plugin in the token set): dense, high-contrast, near-square.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div
      className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-2 [&_h1]:font-mono [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:font-mono [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:font-mono [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:border-border [&_hr]:my-3 [&_li]:ml-4 [&_ol]:list-decimal [&_ol_li]:ml-2 [&_p]:mb-2 [&_pre]:bg-muted [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:p-2 [&_pre_code]:p-0 [&_table]:mb-2 [&_table]:w-full [&_td]:border-border [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border-border [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul_li]:ml-2"
      data-testid="markdown-preview"
    >
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  );
}
