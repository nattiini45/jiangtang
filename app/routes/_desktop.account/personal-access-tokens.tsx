import * as React from "react";
import { useNavigation } from "react-router";
import { ZodForm, FormField, type FieldErrors } from "~/components/forms";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { formatDateTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { tRich } from "~/i18n/rich";
import { cn } from "~/lib/utils";
import { McpConnection } from "~/routes/_desktop.account/mcp-connection";

interface TokenRecord {
  id: string;
  userId: string;
  name: string;
  scope: "READ_ONLY" | "READ_WRITE";
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  revokedAt: Date | string | null;
  owner: { id: string; name: string };
}

interface TokenActionResult {
  intent: string;
  changed?: boolean;
  createdToken?: { token: string; id: string };
  fieldErrors?: FieldErrors;
  formErrors?: string[];
}

function CreatedToken({ token, onHide }: { token: string; onHide: () => void }) {
  const t = useT();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="created-token-heading"
      className="bg-status-warning/15 text-foreground mt-4 rounded-lg p-4"
    >
      <h3 id="created-token-heading" className="text-sm font-semibold">
        {t("account.tokens.created")}
      </h3>
      <p className="mt-2 text-sm font-semibold">{t("account.tokens.warning")}</p>
      <p className="mt-1 text-sm">{t("account.tokens.securityHint")}</p>
      <p className="mt-2 text-sm">
        {tRich(t, "account.tokens.connection.next", {
          help: (
            <a
              href="#mcp-connection"
              className="underline underline-offset-4"
              onClick={() => {
                const help = document.getElementById("mcp-connection");
                if (help instanceof HTMLDetailsElement) {
                  help.open = true;
                  help.querySelector("summary")?.focus();
                }
              }}
            >
              {t("account.tokens.connection.heading")}
            </a>
          ),
        })}
      </p>
      <div className="mt-4">
        <FormField name="created-token" label={t("account.tokens.secret")}>
          <Input
            value={token}
            readOnly
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
        </FormField>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={copy}>
          {t("account.tokens.copy")}
        </Button>
        <Button type="button" variant="ghost" onClick={onHide}>
          {t("account.tokens.hide")}
        </Button>
      </div>
      <p
        aria-live="polite"
        aria-atomic="true"
        className={copyState !== "idle" ? "mt-2 text-sm" : undefined}
      >
        {copyState === "copied"
          ? t("account.tokens.copied")
          : copyState === "failed"
            ? t("account.tokens.copyFailed")
            : ""}
      </p>
    </div>
  );
}

function TokenList({
  tokens,
  showOwner = false,
  busy,
}: {
  tokens: TokenRecord[];
  showOwner?: boolean;
  busy: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  if (!tokens.length)
    return (
      <p className="text-muted-foreground mt-3 text-sm">
        {showOwner ? t("account.tokens.emptyOthers") : t("account.tokens.empty")}
      </p>
    );

  return (
    <ul className="mt-3 space-y-3">
      {[...tokens]
        .sort((a, b) => Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt)))
        .map((token) => (
          <li
            key={token.id}
            className={cn(
              "bg-card shadow-surface-2 rounded-lg p-4",
              token.revokedAt && "text-muted-foreground",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold wrap-anywhere">{token.name}</h4>
                {showOwner ? (
                  <p className="text-muted-foreground mt-1 text-sm wrap-anywhere">
                    {t("account.tokens.owner", { name: token.owner.name })}
                  </p>
                ) : null}
              </div>
              <Badge>
                {token.scope === "READ_ONLY"
                  ? t("account.tokens.readOnly")
                  : t("account.tokens.readWrite")}
              </Badge>
            </div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t("account.tokens.createdAt")}</dt>
              <dd className="nums">{formatDateTime(locale, token.createdAt)}</dd>
              <dt className="text-muted-foreground">{t("account.tokens.lastUsedAt")}</dt>
              <dd className="nums">
                {token.lastUsedAt
                  ? formatDateTime(locale, token.lastUsedAt)
                  : t("account.tokens.neverUsed")}
              </dd>
              <dt className="text-muted-foreground">{t("account.tokens.status")}</dt>
              <dd className="nums">
                {token.revokedAt
                  ? t("account.tokens.revokedAt", { date: formatDateTime(locale, token.revokedAt) })
                  : t("account.tokens.active")}
              </dd>
            </dl>
            {!token.revokedAt ? (
              <ZodForm
                className="mt-3"
                onSubmit={(event) => {
                  if (!confirm(t("account.tokens.confirmRevoke", { name: token.name })))
                    event.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="tokenRevoke" />
                <input type="hidden" name="id" value={token.id} />
                <Button
                  type="submit"
                  variant="secondary"
                  className="self-start"
                  disabled={busy}
                  aria-label={t("account.tokens.revokeNamed", { name: token.name })}
                >
                  {t("account.tokens.revoke")}
                </Button>
              </ZodForm>
            ) : null}
          </li>
        ))}
    </ul>
  );
}

export function PersonalAccessTokens({
  mcpUrl,
  tokens,
  userId,
  isAdmin,
  result,
}: {
  mcpUrl: string;
  tokens: TokenRecord[];
  userId: string;
  isAdmin: boolean;
  result?: TokenActionResult;
}) {
  const t = useT();
  const navigation = useNavigation();
  const formRef = React.useRef<HTMLFormElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const feedbackRef = React.useRef<HTMLParagraphElement>(null);
  const errorRef = React.useRef<HTMLParagraphElement>(null);
  const createResult = result?.intent === "tokenCreate" ? result : undefined;
  const tokenResult = result?.intent.startsWith("token") ? result : undefined;
  const [createdToken, setCreatedToken] = React.useState<TokenActionResult["createdToken"]>();
  const createdSecret = createResult?.createdToken?.token;
  const createdId = createResult?.createdToken?.id;
  React.useEffect(() => {
    if (createdSecret && createdId) {
      setCreatedToken({ token: createdSecret, id: createdId });
      formRef.current?.reset();
    }
  }, [createdSecret, createdId]);
  React.useEffect(() => {
    if (result?.intent === "tokenRevoke" && result.changed) {
      feedbackRef.current?.focus({ preventScroll: true });
      feedbackRef.current?.scrollIntoView({ block: "nearest" });
    }
    if (tokenResult?.formErrors?.length) {
      errorRef.current?.focus({ preventScroll: true });
      errorRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [result, tokenResult]);
  const busy = navigation.state !== "idle";
  const creating = busy && navigation.formData?.get("intent") === "tokenCreate";
  const otherTokens = tokens.filter((token) => token.userId !== userId);

  return (
    <section className="mt-8" aria-labelledby="personal-tokens-heading">
      <h2 id="personal-tokens-heading" className="text-base font-semibold">
        {t("account.tokens.heading")}
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.tokens.intro")}</p>
      <McpConnection url={mcpUrl} />
      {tokenResult?.formErrors?.length ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-destructive mt-4 text-sm">
          {tokenResult.formErrors.join(" ")}
        </p>
      ) : null}
      <ZodForm ref={formRef} className="mt-4" fieldErrors={createResult?.fieldErrors}>
        <input type="hidden" name="intent" value="tokenCreate" />
        <FormField name="name" label={t("account.tokens.name")} hint={t("account.tokens.nameHint")}>
          <Input
            ref={nameRef}
            name="name"
            id="token-name"
            required
            maxLength={120}
            autoComplete="off"
          />
        </FormField>
        <FormField
          name="scope"
          label={t("account.tokens.scope")}
          hint={t("account.tokens.scopeHint")}
        >
          <Select name="scope" id="token-scope" defaultValue="READ_ONLY">
            <option value="READ_ONLY">{t("account.tokens.readOnly")}</option>
            <option value="READ_WRITE">{t("account.tokens.readWrite")}</option>
          </Select>
        </FormField>
        <Button type="submit" disabled={busy || Boolean(createdToken)}>
          {creating ? t("account.tokens.creating") : t("account.tokens.create")}
        </Button>
      </ZodForm>
      {createdToken ? (
        <CreatedToken
          key={createdToken.id}
          token={createdToken.token}
          onHide={() => {
            setCreatedToken(undefined);
            nameRef.current?.focus();
          }}
        />
      ) : null}
      <h3 className="mt-6 text-sm font-semibold">{t("account.tokens.yours")}</h3>
      <p
        ref={feedbackRef}
        tabIndex={-1}
        role="status"
        className={
          result?.intent === "tokenRevoke" && result.changed
            ? "bg-status-info/15 text-foreground mt-3 rounded-lg p-3 text-sm"
            : undefined
        }
      >
        {result?.intent === "tokenRevoke" && result.changed ? t("account.tokens.revoked") : ""}
      </p>
      <TokenList tokens={tokens.filter((token) => token.userId === userId)} busy={busy} />
      {isAdmin ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-semibold">
            {t("account.tokens.all", { count: otherTokens.length })}
          </summary>
          <p className="text-muted-foreground mt-2 text-sm">{t("account.tokens.allHint")}</p>
          <TokenList tokens={otherTokens} showOwner busy={busy} />
        </details>
      ) : null}
    </section>
  );
}
