import { useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useT } from "~/i18n/use-t";

export function InvitationLink({ link }: { link: string }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  if (hidden) return null;
  return (
    <section
      className="bg-card shadow-surface-2 rounded-lg p-4"
      aria-label={t("admin.users.invited.title")}
    >
      <h2 className="text-sm font-semibold">{t("admin.users.invited.title")}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("admin.invitations.linkHint")}</p>
      <Input
        className="mt-3"
        aria-label={t("admin.invitations.link")}
        value={link}
        readOnly
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied("copied");
            } catch {
              setCopied("failed");
            }
          }}
        >
          {t("admin.invitations.copy")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setHidden(true)}>
          {t("admin.invitations.hide")}
        </Button>
        <Button asChild variant="ghost">
          <Link to="/admin/invitations">{t("admin.invitations.title")}</Link>
        </Button>
      </div>
      <p role="status" className="mt-2 text-sm">
        {copied === "copied"
          ? t("admin.invitations.copied")
          : copied === "failed"
            ? t("admin.invitations.copyFailed")
            : ""}
      </p>
    </section>
  );
}
