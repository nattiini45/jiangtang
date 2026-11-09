import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tr } from "~/i18n/request-locale.server";
import type { MessageKey } from "~/i18n";

export function registerPrompts(server: McpServer): void {
  const prompts: Array<{ name: string; description: string; key: MessageKey }> = [
    {
      name: "plan_event",
      description:
        "Plan an event with room suitability, advisory availability and a reviewed booking proposal",
      key: "mcp.prompts.event",
    },
    {
      name: "triage_ticket",
      description: "Assess an incident, request or repair and propose a safe triage plan",
      key: "mcp.prompts.ticket",
    },
    {
      name: "plan_project",
      description:
        "Break a project or task goal into dependencies, assignments and a reviewed work plan",
      key: "mcp.prompts.project",
    },
  ];
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: z.object({ request: z.string().trim().min(1).max(4000) }),
      },
      ({ request }) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `${tr("mcp.prompts.safety")}\n\n${tr(prompt.key)}` },
          },
          { role: "user", content: { type: "text", text: tr("mcp.prompts.request", { request }) } },
        ],
      }),
    );
  }
}
