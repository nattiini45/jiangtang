import * as React from "react";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";

export function mcpClientConfigs(url: string) {
  return {
    claude: JSON.stringify(
      {
        mcpServers: {
          jiangtang: {
            type: "http",
            url,
            headers: { Authorization: "Bearer ${JIANGTANG_MCP_TOKEN}" },
          },
        },
      },
      null,
      2,
    ),
    cursor: JSON.stringify(
      {
        mcpServers: {
          jiangtang: { url, headers: { Authorization: "Bearer ${env:JIANGTANG_MCP_TOKEN}" } },
        },
      },
      null,
      2,
    ),
  };
}

function Copyable({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="mt-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{label}</p>
        <Button
          type="button"
          variant="ghost"
          aria-label={t("account.tokens.connection.copyNamed", { name: label })}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setState("copied");
            } catch {
              setState("failed");
            }
          }}
        >
          {t("account.tokens.connection.copy")}
        </Button>
      </div>
      <pre className="bg-card shadow-surface-2 mt-1 rounded-lg p-3 text-xs whitespace-pre-wrap break-all">
        <code>{value}</code>
      </pre>
      <p aria-live="polite" aria-atomic="true" className="mt-1 text-sm">
        {state === "copied"
          ? t("account.tokens.connection.copied")
          : state === "failed"
            ? t("account.tokens.connection.copyFailed")
            : ""}
      </p>
    </div>
  );
}

export function McpConnection({ url }: { url: string }) {
  const t = useT();
  const configs = mcpClientConfigs(url);
  return (
    <div className="mt-6">
      <Copyable label={t("account.tokens.connection.address")} value={url} />
      <details id="mcp-connection" className="mt-3 scroll-mt-20">
        <summary className="cursor-pointer text-sm font-semibold">
          {t("account.tokens.connection.heading")}
        </summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>{t("account.tokens.connection.stepCreate")}</li>
          <li>{t("account.tokens.connection.stepEnvironment")}</li>
          <li>{t("account.tokens.connection.stepConfigure")}</li>
        </ol>
        <p className="mt-3 text-sm">{t("account.tokens.connection.trust")}</p>
        <p className="mt-2 text-sm">
          {t("account.tokens.connection.header")} <code>Authorization: Bearer &lt;token&gt;</code>
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("account.tokens.connection.claude")}
        </p>
        <Copyable label={t("account.tokens.connection.claudeLabel")} value={configs.claude} />
        <p className="text-muted-foreground mt-4 text-sm">
          {t("account.tokens.connection.cursor")}
        </p>
        <Copyable label={t("account.tokens.connection.cursorLabel")} value={configs.cursor} />
        <p className="text-muted-foreground mt-3 text-sm">{t("account.tokens.connection.oauth")}</p>
      </details>
    </div>
  );
}
