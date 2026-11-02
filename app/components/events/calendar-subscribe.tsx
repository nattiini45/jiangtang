import * as React from "react";
import { CalendarPlus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";

/**
 * "Kalender abonnieren" affordance for admins (iCal feed). Reveals the
 * token-gated `.ics` URL with a copy-to-clipboard button. The URL already
 * carries the token, so the team calendar subscribes without a separate auth
 * step. Server-rendered (the URL is built in the loader); copy uses the
 * async clipboard API with a legacy fallback.
 */
export function CalendarSubscribe({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Legacy fallback: select-and-copy via a hidden input.
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // give up silently — the URL is visible to copy manually
      }
      document.body.removeChild(input);
    }
  }

  return (
    <Button type="button" variant="tertiary" size="compact" onClick={copy} title={url}>
      <CalendarPlus className="size-4" />
      {copied ? t("events.subscribe.copied") : t("events.subscribe.button")}
    </Button>
  );
}
