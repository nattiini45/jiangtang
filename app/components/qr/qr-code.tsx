import { useT } from "~/i18n/use-t";
import type { MessageKey } from "~/i18n";

/**
 * Presentational QR block: an SVG rendered server-side (see `~/lib/qr.server`)
 * plus the plain link, so the target works without a camera too. `dangerouslySetInnerHTML`
 * is safe here: `qrcode` escapes the encoded text and emits only SVG markup.
 */
export function QrCode({
  svg,
  href,
  titleKey,
}: {
  svg: string;
  href: string;
  titleKey: MessageKey;
}) {
  const t = useT();
  return (
    <section className="bg-card shadow-surface-2 flex items-center gap-4 rounded-lg p-4">
      <div
        className="bg-qr-paper shrink-0 rounded-md p-1 [&>svg]:block [&>svg]:size-36"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-base font-semibold">{t(titleKey)}</h2>
        <a
          href={href}
          className="text-muted-foreground hover:text-foreground break-all text-xs underline decoration-(--input) underline-offset-4"
        >
          {href}
        </a>
      </div>
    </section>
  );
}
