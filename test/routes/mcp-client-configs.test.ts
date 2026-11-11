import { describe, expect, it } from "vitest";
import { mcpClientConfigs } from "~/routes/_desktop.account/mcp-connection";

describe("MCP client configurations", () => {
  const url = "https://workspace.example.test:8443/mcp";
  const configs = mcpClientConfigs(url);

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
