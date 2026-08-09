import { describe, it, expect } from "vitest";
import {
  dispatchAgentApiRequest, parseRequestTarget, pathMatcher,
  UNAUTHENTICATED_HTTP_ROUTE_IDS,
} from "./agent-api-router.js";
import type { AgentApiRoute, AgentApiDispatcherDeps, ParsedRequestTarget } from "./agent-api-router.js";

type Callback = (chunk: Buffer) => void;

function makeReq(overrides: Partial<{ url: string; method: string; remoteAddress: string; headers: Record<string, string | string[] | undefined> }> = {}) {
  const listeners = new Map<string, Callback[]>();
  const req = {
    url: "/v1/x",
    method: "GET",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    on(ev: string, cb: Callback) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), cb]);
      return req;
    },
    headers: {},
    removeListener(ev: string, cb: Callback) { void ev; void cb; return req; },
    resume() {},
    _listeners: listeners,
  } as any;
  Object.assign(req, overrides);
  if (overrides.remoteAddress !== undefined) req.socket.remoteAddress = overrides.remoteAddress;
  return req;
}

function makeRes() {
  const written: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      written.status = status;
      written.headers = headers;
      return res;
    },
    end(body?: string) { written.body = body; },
    headersSent: false,
    _written: written,
  } as any;
  return res;
}

/** Feed a string body through the fake req's data/end listeners. */
function emitBody(req: any, body: string): void {
  for (const cb of req._listeners.get("data") ?? []) cb(Buffer.from(body));
  for (const cb of req._listeners.get("end") ?? []) cb(Buffer.alloc(0));
}

/** Dispatcher deps that succeed by default and record calls. */
function makeDeps(overrides: Partial<AgentApiDispatcherDeps> = {}) {
  const calls: string[] = [];
  const deps: AgentApiDispatcherDeps & { calls: string[] } = {
    calls,
    verifyBodylessPeer(req, res) {
      calls.push("bodyless");
      const id = req.headers["x-peer-id"];
      if (typeof id !== "string") { res.writeHead(401).end("no peer"); return null; }
      return id;
    },
    async authenticatePeerBody(req, res, options) {
      calls.push(`peerBody:${options.rateLimited ? "rl" : "plain"}`);
      const id = req.headers["x-peer-id"];
      if (typeof id !== "string") { res.writeHead(401).end("no peer"); return null; }
      emitBody(req, req._body ?? "{}");
      return { caller: id, rawBody: req._body ?? "{}" };
    },
    requireLoopback(req, res) {
      calls.push("loopback");
      const loopback = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
      if (!loopback) { res.writeHead(401).end("loopback only"); return false; }
      return true;
    },
    async readBodyBounded(req, maxBytes) {
      calls.push("readBounded");
      void maxBytes;
      emitBody(req, req._body ?? "{}");
      return req._body ?? "{}";
    },
    ...overrides,
  };
  return deps;
}

function route(overrides: Partial<AgentApiRoute>): AgentApiRoute {
  return {
    id: "test.route",
    method: "GET",
    match: pathMatcher("/v1/x"),
    auth: { kind: "peer" },
    body: { kind: "none" },
    handler: () => {},
    ...overrides,
  };
}

describe("parseRequestTarget", () => {
  it("splits pathname from query without altering the raw string", () => {
    const t = parseRequestTarget("/v1/tasks/42/messages?since=2026-01-01T00:00:00Z&limit=5");
    expect(t.pathname).toBe("/v1/tasks/42/messages");
    expect(t.query).toEqual({ since: "2026-01-01T00:00:00Z", limit: "5" });
  });

  it("handles a target with no query", () => {
    expect(parseRequestTarget("/v1/models")).toEqual({ pathname: "/v1/models", query: {} });
  });
});

describe("pathMatcher", () => {
  it("extracts params and rejects extra segments", () => {
    const m = pathMatcher("/v1/pi-runs/:runId/events/acknowledge");
    expect(m({ pathname: "/v1/pi-runs/r_9/events/acknowledge", query: {} })).toEqual({ runId: "r_9" });
    expect(m({ pathname: "/v1/pi-runs/r_9/events/acknowledge/extra", query: {} })).toBe(false);
    expect(m({ pathname: "/v1/pi-runs/r_9/events", query: {} })).toBe(false);
  });

  it("decodes URL-encoded parameters", () => {
    const m = pathMatcher("/v1/models/:id");
    expect(m({ pathname: "/v1/models/gpt-4%20mini", query: {} })).toEqual({ id: "gpt-4 mini" });
  });
});

describe("dispatchAgentApiRequest", () => {
  it("returns 404 when no route matches method or path", async () => {
    const res = makeRes();
    await dispatchAgentApiRequest(
      [route({ method: "POST" })],
      makeDeps(),
      makeReq({ url: "/v1/other", method: "GET" }),
      res,
    );
    expect(res._written.status).toBe(404);
  });

  it("selects the first matching route and extracts params + query", async () => {
    const calls: string[] = [];
    const res = makeRes();
    await dispatchAgentApiRequest(
      [
        route({ id: "a", match: pathMatcher("/v1/tasks/:cardId/messages"), handler: (ctx) => { calls.push(`a:${ctx.params.cardId}:${ctx.query.limit}`); } }),
        route({ id: "b", match: pathMatcher("/v1/tasks/:other/messages"), handler: () => { calls.push("b"); } }),
      ],
      makeDeps(),
      makeReq({ url: "/v1/tasks/42/messages?limit=7", method: "GET", headers: { "x-peer-id": "alice" } }),
      res,
    );
    expect(calls).toEqual(["a:42:7"]);
  });

  it("runs bodyless peer auth before the handler and passes the caller", async () => {
    const calls: string[] = [];
    const res = makeRes();
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ handler: (ctx) => { calls.push(`handler:${ctx.caller}`); } })],
      deps,
      makeReq({ url: "/v1/x", headers: { "x-peer-id": "alice" } }),
      res,
    );
    expect(deps.calls).toEqual(["bodyless"]);
    expect(calls).toEqual(["handler:alice"]);
  });

  it("blocks the handler when peer auth fails", async () => {
    const res = makeRes();
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ handler: () => { throw new Error("should not run"); } })],
      deps,
      makeReq({ url: "/v1/x" }),
      res,
    );
    expect(deps.calls).toEqual(["bodyless"]);
    expect(res._written.status).toBe(401);
  });

  it("authenticates a signed JSON body before parsing and passes it to the handler", async () => {
    const calls: string[] = [];
    const res = makeRes();
    const req = makeReq({ url: "/v1/x", method: "POST", headers: { "x-peer-id": "alice" } });
    req._body = '{"hello":"world"}';
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ method: "POST", body: { kind: "json", maxBytes: 1024 }, handler: (ctx) => { calls.push(`handler:${JSON.stringify(ctx.body)}:${ctx.caller}`); } })],
      deps,
      req,
      res,
    );
    expect(deps.calls).toEqual(["peerBody:plain"]);
    expect(calls).toEqual(["handler:{\"hello\":\"world\"}:alice"]);
  });

  it("blocks handler dispatch and body parse when peer body auth fails", async () => {
    const res = makeRes();
    const req = makeReq({ url: "/v1/x", method: "POST" });
    req._body = "{}";
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ method: "POST", body: { kind: "json", maxBytes: 1024 }, handler: () => { throw new Error("should not run"); } })],
      deps,
      req,
      res,
    );
    expect(deps.calls).toEqual(["peerBody:plain"]);
    expect(res._written.status).toBe(401);
  });

  it("applies the peer rate-limit option on signed JSON routes", async () => {
    const calls: string[] = [];
    const res = makeRes();
    const req = makeReq({ url: "/v1/x", method: "POST", headers: { "x-peer-id": "alice" } });
    req._body = "{}";
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ method: "POST", auth: { kind: "peer", rateLimited: true }, body: { kind: "json", maxBytes: 1024 }, handler: () => { calls.push("handler"); } })],
      deps,
      req,
      res,
    );
    expect(deps.calls).toEqual(["peerBody:rl"]);
    expect(calls).toEqual(["handler"]);
  });

  it("runs the loopback guard before reading or parsing a loopback JSON body", async () => {
    const res = makeRes();
    const req = makeReq({ url: "/v1/x", method: "POST", remoteAddress: "100.82.167.127" });
    req._body = "{}";
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ method: "POST", auth: { kind: "loopback" }, body: { kind: "json", maxBytes: 1024 }, handler: () => { throw new Error("should not run"); } })],
      deps,
      req,
      res,
    );
    expect(deps.calls).toEqual(["loopback"]);
    expect(res._written.status).toBe(401);
  });

  it("reads a loopback JSON body only after the guard succeeds", async () => {
    const calls: string[] = [];
    const res = makeRes();
    const req = makeReq({ url: "/v1/x", method: "POST" });
    req._body = '{"n":1}';
    const deps = makeDeps();
    await dispatchAgentApiRequest(
      [route({ method: "POST", auth: { kind: "loopback" }, body: { kind: "json", maxBytes: 1024 }, handler: (ctx) => { calls.push(`handler:${JSON.stringify(ctx.body)}`); } })],
      deps,
      req,
      res,
    );
    expect(deps.calls).toEqual(["loopback", "readBounded"]);
    expect(calls).toEqual(["handler:{\"n\":1}"]);
  });

  it("converts uncaught handler failures to the internal-error 500", async () => {
    const res = makeRes();
    await dispatchAgentApiRequest(
      [route({ handler: () => { throw new Error("boom"); } })],
      makeDeps(),
      makeReq({ url: "/v1/x", headers: { "x-peer-id": "alice" } }),
      res,
    );
    expect(res._written.status).toBe(500);
    expect(JSON.parse(res._written.body!).error.message).toContain("Internal server error");
  });

  it("does not write a 500 over an already-committed response", async () => {
    const res = makeRes();
    res.headersSent = true;
    await dispatchAgentApiRequest(
      [route({ handler: () => { throw new Error("boom"); } })],
      makeDeps(),
      makeReq({ url: "/v1/x", headers: { "x-peer-id": "alice" } }),
      res,
    );
    expect(res._written.status).toBeUndefined();
  });
});

describe("unauthenticated HTTP allowlist (#1557)", () => {
  it("is empty — no public route can be constructed today", () => {
    expect(UNAUTHENTICATED_HTTP_ROUTE_IDS).toEqual([]);
  });
});
