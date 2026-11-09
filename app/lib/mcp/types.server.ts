import type { AuditActor } from "~/lib/audit.server";

export interface McpContext {
  user: {
    id: string;
    name: string;
    email: string;
    initials: string | null;
    role: "ADMIN" | "MEMBER";
  };
  token: {
    id: string;
    name: string;
    scope: "READ_ONLY" | "READ_WRITE";
  };
}

export function mcpActor(context: McpContext): AuditActor & McpContext["user"] {
  return {
    ...context.user,
    via: { kind: "mcp", tokenId: context.token.id, tokenName: context.token.name },
  };
}
