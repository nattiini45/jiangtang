import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  withStaticSpan: vi.fn((callback: unknown) => callback),
}));
vi.mock("@sentry/node", () => sentry);

/**
 * Pins the options the app passes to Sentry.init. The SDK is mocked, so these tests show
 * what the app asks for, not how the SDK applies it. Typecheck verifies the option names.
 */

const DSN = "https://public@glitchtip.example.test/1";

// Synthetic feed token, invite token and query string that must not reach the event.
const LEAK_PATTERN = /abc123|tok456|q=x/;

describe("initSentry", () => {
  const originalDsn = process.env.GLITCHTIP_DSN;

  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.withStaticSpan.mockClear();
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.GLITCHTIP_DSN;
    else process.env.GLITCHTIP_DSN = originalDsn;
  });

  async function initOptions() {
    process.env.GLITCHTIP_DSN = DSN;
    const { initSentry } = await import("~/lib/observability/sentry.server");
    initSentry();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    return sentry.init.mock.calls[0][0];
  }

  it("does not initialize without a DSN", async () => {
    delete process.env.GLITCHTIP_DSN;
    const { initSentry } = await import("~/lib/observability/sentry.server");
    initSentry();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("passes personal data collection opt-outs to Sentry.init once", async () => {
    process.env.GLITCHTIP_DSN = DSN;
    const { initSentry } = await import("~/lib/observability/sentry.server");
    initSentry();
    initSentry();

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0][0];
    expect(options).toMatchObject({ dsn: DSN, tracesSampleRate: 0.2, traceLifecycle: "static" });
    expect(options).not.toHaveProperty("sendDefaultPii");
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      httpHeaders: {
        request: {
          deny: expect.arrayContaining(["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]),
        },
      },
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    });
  });

  it("registers the span hook through withStaticSpan", async () => {
    const options = await initOptions();

    expect(sentry.withStaticSpan).toHaveBeenCalledTimes(1);
    expect(options.beforeSendSpan).toBe(sentry.withStaticSpan.mock.results[0]?.value);
  });

  it("removes tokens and query strings from error events", async () => {
    const options = await initOptions();
    const event = options.beforeSend(
      {
        transaction: "GET /calendar/abc123.ics",
        request: {
          url: "https://app.example.test/calendar/abc123.ics?q=x",
          method: "GET",
          headers: {
            referer: "https://app.example.test/accept-invite/tok456?next=1",
            "user-agent": "test-agent",
          },
        },
      },
      {},
    );

    expect(JSON.stringify(event)).not.toMatch(LEAK_PATTERN);
    expect(event.transaction).toBe("GET /calendar/:token");
    expect(event.request.url).toBe("https://app.example.test/calendar/:token");
    expect(event.request.headers.referer).toBe("https://app.example.test/accept-invite/:token");
    expect(event.request.headers["user-agent"]).toBe("test-agent");
    expect(event.request.method).toBe("GET");
  });

  it("removes tokens and query strings from transactions", async () => {
    const options = await initOptions();
    const transaction = options.beforeSendTransaction({
      type: "transaction",
      transaction: "GET /accept-invite/tok456",
      request: { url: "https://app.example.test/accept-invite/tok456?q=x" },
    });

    expect(JSON.stringify(transaction)).not.toMatch(LEAK_PATTERN);
    expect(transaction.transaction).toBe("GET /accept-invite/:token");
    expect(transaction.request.url).toBe("https://app.example.test/accept-invite/:token");
  });

  it("removes tokens from every forwarded request header, and query strings from URL headers", async () => {
    const options = await initOptions();
    const headers = () => ({
      "x-original-uri": "/calendar/abc123.ics?q=x",
      "x-original-url": "/accept-invite/tok456?next=1",
      "x-envoy-original-path": "/calendar/abc123.ics",
      "x-custom-trace": "seen at /accept-invite/tok456",
      "user-agent": "test-agent",
    });
    const event = options.beforeSend(
      { request: { url: "https://app.example.test/", headers: headers() } },
      {},
    );
    const transaction = options.beforeSendTransaction({
      type: "transaction",
      request: { url: "https://app.example.test/", headers: headers() },
    });

    for (const sent of [event, transaction]) {
      expect(JSON.stringify(sent)).not.toMatch(LEAK_PATTERN);
      expect(sent.request.headers).toEqual({
        "x-original-uri": "/calendar/:token",
        "x-original-url": "/accept-invite/:token",
        "x-envoy-original-path": "/calendar/:token",
        "x-custom-trace": "seen at /accept-invite/:token",
        "user-agent": "test-agent",
      });
    }
  });

  it("removes tokens from span names, URL attributes and referer values", async () => {
    const options = await initOptions();
    const span = options.beforeSendSpan({
      description: "GET /calendar/abc123.ics",
      data: {
        "url.full": "https://app.example.test/calendar/abc123.ics?q=x",
        "url.path": "/calendar/abc123.ics",
        "http.request.header.referer": ["https://app.example.test/accept-invite/tok456"],
        "http.request.method": "GET",
        "db.statement": "SELECT 1 FROM Room WHERE id = $1",
      },
    });

    expect(JSON.stringify(span)).not.toMatch(LEAK_PATTERN);
    expect(span.description).toBe("GET /calendar/:token");
    expect(span.data["url.full"]).toBe("https://app.example.test/calendar/:token");
    expect(span.data["url.path"]).toBe("/calendar/:token");
    expect(span.data["http.request.header.referer"]).toEqual([
      "https://app.example.test/accept-invite/:token",
    ]);
    expect(span.data["http.request.method"]).toBe("GET");
    expect(span.data["db.statement"]).toBe("SELECT 1 FROM Room WHERE id = $1");
  });

  it("removes tokens from every request header attribute on a span", async () => {
    const options = await initOptions();
    const span = options.beforeSendSpan({
      description: "GET /",
      data: {
        "http.request.header.x-original-uri": ["/calendar/abc123.ics?q=x"],
        "http.request.header.x-original-url": ["/accept-invite/tok456?next=1"],
        "http.request.header.x-custom-trace": ["seen at /accept-invite/tok456"],
        "http.request.header.user-agent": ["test-agent"],
      },
    });

    expect(JSON.stringify(span)).not.toMatch(LEAK_PATTERN);
    expect(span.data).toEqual({
      "http.request.header.x-original-uri": ["/calendar/:token"],
      "http.request.header.x-original-url": ["/accept-invite/:token"],
      "http.request.header.x-custom-trace": ["seen at /accept-invite/:token"],
      "http.request.header.user-agent": ["test-agent"],
    });
  });

  it("removes tokens and query strings from breadcrumb URLs", async () => {
    const options = await initOptions();
    const breadcrumb = options.beforeBreadcrumb({
      category: "http",
      data: { url: "https://app.example.test/calendar/abc123.ics?q=x", method: "GET" },
    });

    expect(JSON.stringify(breadcrumb)).not.toMatch(LEAK_PATTERN);
    expect(breadcrumb.data.url).toBe("https://app.example.test/calendar/:token");
    expect(breadcrumb.data.method).toBe("GET");
  });

  it("drops console breadcrumbs, whose text can repeat a URL", async () => {
    const options = await initOptions();
    const breadcrumb = options.beforeBreadcrumb({
      category: "console",
      level: "log",
      message: "GET /accept-invite/tok456?q=x",
      data: { arguments: ["GET /accept-invite/tok456?q=x"], logger: "console" },
    });

    expect(breadcrumb).toBeNull();
  });
});
