import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import {
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "~/domains/api-tokens/api-tokens.server";
import { register, MCP_RATE_LIMIT } from "~/lib/mcp/mcp.boot.server";

describe("MCP Streamable HTTP authentication", () => {
  let server: Server;
  let url: URL;
  let user: { id: string; name: string; email: string; role: "MEMBER" };
  let token: string;

  beforeAll(async () => {
    const created = await db.user.create({
      data: {
        email: `mcp-http-${crypto.randomUUID()}@example.test`,
        name: "Synthetic HTTP member",
      },
    });
    user = { ...created, role: "MEMBER" };
    token = (await createPersonalAccessToken(user, { name: "HTTP test", scope: "READ_ONLY" }))
      .token;
    const app = express();
    register(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test did not bind");
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (user) await db.user.delete({ where: { id: user.id } });
  });

  function request(rawToken: string | undefined = token, options: RequestInit = {}) {
    return fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(rawToken ? { Authorization: `Bearer ${rawToken}` } : {}),
        ...options.headers,
      },
    });
  }

  it("returns 401 with a Bearer challenge for missing and invalid credentials", async () => {
    const missing = await request("");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await request("jtg_invalid")).status).toBe(401);
  });

  it("rejects untrusted origins and hosts before processing a token", async () => {
    expect((await request(token, { headers: { Origin: "https://evil.example" } })).status).toBe(
      403,
    );
    expect((await request(token, { headers: { Origin: "null" } })).status).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        url,
        { headers: { Host: "evil.example", Authorization: `Bearer ${token}` } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("connects an official SDK client over HTTP with no cookie session", async () => {
    const client = new Client({ name: "jiangtang-http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("list_rooms");
      expect(names).toContain("search_workspace");
      for (const excluded of [
        "list_users",
        "create_user",
        "delete_user",
        "create_invite",
        "change_role",
        "export_workspace",
        "import_workspace",
        "erase_user",
        "create_token",
        "revoke_token",
      ]) {
        expect(names).not.toContain(excluded);
      }
      expect(names.some((name) => /(?:password|two_factor|admin_settings|gdpr)/.test(name))).toBe(
        false,
      );
      const rooms = await client.callTool({
        name: "list_rooms",
        arguments: { limit: 1, offset: 0 },
      });
      expect(rooms.isError).not.toBe(true);
      const reads: [string, Record<string, unknown>][] = [
        ["list_campuses", {}],
        ["list_buildings", {}],
        ["list_locations", {}],
        ["list_equipment_models", {}],
        ["list_equipment", {}],
        ["list_stock", {}],
        ["list_events", {}],
        ["list_room_bookings", {}],
        ["list_equipment_allocations", {}],
        ["list_tickets", {}],
        ["list_tasks", {}],
        ["list_projects", {}],
        ["list_notes", {}],
        ["list_note_tags", {}],
        ["list_vendors", {}],
        ["list_board", { kind: "task", lane: "BACKLOG" }],
        ["list_board", { kind: "ticket", lane: "BACKLOG", projectId: "missing-project" }],
        ["list_time_entries", { isoWeek: "2026-W45" }],
        ["list_activity", {}],
        ["list_notifications", {}],
      ];
      for (const [name, args] of reads) {
        const result = await client.callTool({ name, arguments: { ...args, limit: 1 } });
        expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("supports current-protocol discovery as well as legacy clients", async () => {
    const response = await request(token, {
      headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it("checks token revocation and user deactivation on every request", async () => {
    const issued = await createPersonalAccessToken(user, {
      name: "Revoke HTTP",
      scope: "READ_ONLY",
    });
    expect((await request(issued.token)).status).toBe(200);
    await revokePersonalAccessToken(user, issued.record.id);
    expect((await request(issued.token)).status).toBe(401);
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    try {
      expect((await request()).status).toBe(401);
    } finally {
      await db.user.update({ where: { id: user.id }, data: { isActive: true } });
    }
  });

  it("bounds requests independently per token and returns Retry-After", async () => {
    const limited = await createPersonalAccessToken(user, {
      name: "Rate limit HTTP",
      scope: "READ_ONLY",
    });
    for (let index = 0; index < MCP_RATE_LIMIT; index++) {
      expect((await request(limited.token, { method: "GET", body: undefined })).status).toBe(405);
    }
    const blocked = await request(limited.token, { method: "GET", body: undefined });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const independent = await createPersonalAccessToken(user, {
      name: "Independent HTTP",
      scope: "READ_ONLY",
    });
    expect((await request(independent.token, { method: "GET", body: undefined })).status).toBe(405);
  });
});
