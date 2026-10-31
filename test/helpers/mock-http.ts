/**
 * Loopback-only mock HTTP server for provider tests — no test may call a
 * real endpoint. Binds `127.0.0.1:0`, records every request (method, url,
 * headers, raw body), and lets each test script the response.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockReply {
  status?: number;
  /** Sent as application/json when set. */
  json?: unknown;
  /** Raw body (text/plain unless `contentType` is set) — for SSE and error pages. */
  text?: string | Buffer;
  /** Body written as separate TCP chunks — exercises split-event SSE parsing. */
  stream?: Array<string | Buffer>;
  contentType?: string;
}

export type MockHandler = (req: RecordedRequest) => MockReply | Promise<MockReply>;

export interface MockServer {
  /** e.g. `http://127.0.0.1:51234` — no trailing slash. */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function mockHttp(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on(
      "end",
      () =>
        void (async () => {
          const recorded: RecordedRequest = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          requests.push(recorded);
          const reply = await handler(recorded);
          const status = reply.status ?? 200;
          if (reply.json !== undefined) {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(reply.json));
          } else {
            res.writeHead(status, { "content-type": reply.contentType ?? "text/plain" });
            if (reply.stream) {
              for (const chunk of reply.stream) res.write(chunk);
              res.end();
            } else {
              res.end(reply.text ?? "");
            }
          }
        })(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
