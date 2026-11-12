import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mcpAgentPrompt, mcpClientConfigs } from "~/routes/_desktop.account/mcp-connection";
import { t } from "~/i18n";

describe("MCP client configurations", () => {
  const url = "https://workspace.example.test:8443/mcp";
  const configs = mcpClientConfigs(url);

  it("keeps the English documentation prompt aligned with the account page", () => {
    const prompt = mcpAgentPrompt(
      (key, params) => t("en", key, params),
      "https://YOUR_INSTALLATION/mcp",
    );
    expect(readFileSync("docs/MCP.md", "utf8")).toContain(prompt);
  });

  it.each(["en", "de"] as const)(
    "%s agent prompt references credentials without embedding them",
    (locale) => {
      const prompt = mcpAgentPrompt((key, params) => t(locale, key, params), url);
      expect(prompt).toContain(url);
      expect(prompt).toContain("JIANGTANG_MCP_TOKEN");
      expect(prompt).toContain("Streamable HTTP");
      expect(prompt).toContain("jiangtang");
      expect(prompt).not.toContain("jtg_");
      expect(prompt).not.toContain("{url}");
    },
  );

  it.each(Object.entries(configs))(
    "%s is pasteable JSON with no embedded credential",
    (_, text) => {
      const { jiangtang } = JSON.parse(text).mcpServers;
      expect(jiangtang.url).toBe(url);
      expect(text).toContain("JIANGTANG_MCP_TOKEN");
      expect(text).not.toContain("jtg_");
    },
  );

  it("leaves variable expansion to each client rather than the shell", () => {
    expect(JSON.parse(configs.claude).mcpServers.jiangtang).toEqual({
      type: "http",
      url,
      headers: { Authorization: "Bearer ${JIANGTANG_MCP_TOKEN}" },
    });
    expect(JSON.parse(configs.cursor).mcpServers.jiangtang.headers).toEqual({
      Authorization: "Bearer ${env:JIANGTANG_MCP_TOKEN}",
    });
  });
});
