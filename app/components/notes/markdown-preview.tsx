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
 * plugin in the token set): body text stays foreground, blocks are spaced 12px
 * apart, and only code keeps the monospace face.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div
      className="text-foreground space-y-3 text-sm leading-relaxed [&_a]:underline [&_a]:decoration-(--input) [&_a]:underline-offset-4 [&_a:hover]:decoration-current [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:bg-tint [&_code]:rounded-xs [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-semibold [&_hr]:border-border [&_li]:ml-4 [&_ol]:list-decimal [&_ol_li]:ml-2 [&_pre]:bg-tint [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border-border [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border-border [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_ul]:list-disc [&_ul_li]:ml-2 [&_.task-list-item]:list-none [&_.task-list-item]:-ml-4 [&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle"
      data-testid="markdown-preview"
    >
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  );
}
