import { IncomingMessage, ServerResponse } from "http";
import { logWarn } from "./logger.js";
import { openaiError } from "./openai-compat-translate.js";

/**
 * #1557 — Declarative agent API routing.
 *
 * The route registry is executable configuration: the same objects the
 * dispatcher walks are the objects the policy contract test inspects. There
 * is deliberately no second metadata table that could drift from dispatch.
 *
 * Authentication is owned by the dispatcher, never by a handler. A handler
 * cannot be reached until its declared policy succeeds.
 */

/** Explicit allowlist of HTTP route IDs that need no authentication. Empty
 *  today; adding a public endpoint requires a visible change here and a
 *  policy-test update. With an empty `as const` array, `auth: { kind: "none" }`
 *  has no constructable `allowlistId` and cannot be written. */
export const UNAUTHENTICATED_HTTP_ROUTE_IDS = [] as const;
type UnauthenticatedHttpRouteId = typeof UNAUTHENTICATED_HTTP_ROUTE_IDS[number];

export type RouteBody =
  | { kind: "none" }
  | { kind: "json"; maxBytes: number };

export type RouteAuth =
  | { kind: "peer"; rateLimited?: boolean }
  | { kind: "loopback" }
  | { kind: "none"; allowlistId: UnauthenticatedHttpRouteId };

/** Parsed request target. The raw `req.url` is never altered — signature
 *  verification keeps consuming the exact original target. */
export interface ParsedRequestTarget {
  pathname: string;
  query: Record<string, string>;
}

export interface AgentApiRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Authenticated peer caller — present only for routes with peer auth. */
  caller?: string;
  /** Parsed JSON body — present only for routes with a json body policy. */
  body?: unknown;
}

export interface AgentApiRoute {
  id: string;
  method: "GET" | "POST";
  /** Returns extracted path parameters, or false when the target doesn't match. */
  match(target: ParsedRequestTarget): false | Record<string, string>;
  auth: RouteAuth;
  body: RouteBody;
  handler(ctx: AgentApiRouteContext): void | Promise<void>;
}

/** Narrow security primitives injected by AgentApiServer. The router does not
 *  reimplement signature verification, replay protection, peer rate limiting,
 *  or body reading — it only orders them. */
export interface AgentApiDispatcherDeps {
  /** Peer auth for bodyless routes: caller name or null (response written). */
  verifyBodylessPeer(req: IncomingMessage, res: ServerResponse): string | null;
  /** Peer auth for signed JSON routes: caller + exact raw body, or null (response written). */
  authenticatePeerBody(
    req: IncomingMessage,
    res: ServerResponse,
    options: { maxBytes: number; rateLimited?: boolean },
  ): Promise<{ caller: string; rawBody: string } | null>;
  /** Loopback guard: true allows, false already wrote the refusal. */
  requireLoopback(req: IncomingMessage, res: ServerResponse): boolean;
  /** Bounded body read for loopback JSON routes (after the guard succeeds). */
  readBodyBounded(req: IncomingMessage, maxBytes: number): Promise<string>;
}

/** Split a raw request target into pathname + query without touching the raw
 *  string (peer signature verification still receives `req.url` unchanged). */
export function parseRequestTarget(raw: string): ParsedRequestTarget {
  const qIndex = raw.indexOf("?");
  const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const queryRaw = qIndex === -1 ? "" : raw.slice(qIndex + 1);
  const query: Record<string, string> = {};
  if (queryRaw) {
    for (const [k, v] of new URLSearchParams(queryRaw)) query[k] = v;
  }
  return { pathname, query };
}

/** Build an anchored matcher from a "/v1/.../:param" pattern. The pattern is
 *  anchored at both ends so undocumented extra path segments are rejected.
 *  Static segments are matched literally; ":name" segments match one segment. */
export function pathMatcher(pattern: string): (target: ParsedRequestTarget) => false | Record<string, string> {
  const segments = pattern.split("/").filter(Boolean);
  const source = "^/" + segments.map((seg) => {
    if (seg.startsWith(":")) return "([^/]+)";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/") + "$";
  const regex = new RegExp(source);
  return (target) => {
    const m = regex.exec(target.pathname);
    if (!m) return false;
    const params: Record<string, string> = {};
    let capture = 1;
    for (const seg of segments) {
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(m[capture]!);
        capture += 1;
      }
    }
    return params;
  };
}

function internalError(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(500, { "Content-Type": "application/json" })
    .end(JSON.stringify(openaiError("Internal server error", "server_error")));
}

/**
 * #1557 — Central dispatcher. Sequence:
 *  1. Parse the target (raw target untouched for signature verification).
 *  2. First route matching method + path wins; otherwise 404.
 *  3. Enforce the route's declared auth policy before any body read or handler.
 *  4. JSON routes parse the authenticated/guard-approved body exactly once.
 *  5. Uncaught async handler failures become the standard 500 (if headers
 *     haven't been sent).
 */
export async function dispatchAgentApiRequest(
  routes: readonly AgentApiRoute[],
  deps: AgentApiDispatcherDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const target = parseRequestTarget(req.url ?? "");

  let route: AgentApiRoute | undefined;
  let params: Record<string, string> = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.match(target);
    if (match !== false) { route = r; params = match; break; }
  }
  if (!route) {
    res.writeHead(404).end();
    return;
  }

  let caller: string | undefined;
  let rawBody: string | undefined;

  try {
    if (route.auth.kind === "peer") {
      if (route.body.kind === "none") {
        const c = deps.verifyBodylessPeer(req, res);
        if (c === null) return;
        caller = c;
      } else {
        const result = await deps.authenticatePeerBody(req, res, {
          maxBytes: route.body.maxBytes,
          rateLimited: route.auth.rateLimited,
        });
        if (!result) return;
        caller = result.caller;
        rawBody = result.rawBody;
      }
    } else if (route.auth.kind === "loopback") {
      if (!deps.requireLoopback(req, res)) return;
      if (route.body.kind === "json") {
        rawBody = await deps.readBodyBounded(req, route.body.maxBytes);
      }
    } else {
      // "none" auth — only reachable for an allowlisted route ID. The
      // allowlist is empty today, so this branch cannot be constructed.
      if (!(UNAUTHENTICATED_HTTP_ROUTE_IDS as readonly string[]).includes(route.auth.allowlistId)) {
        logAndReject(res, "route not allowlisted for unauthenticated access");
        return;
      }
    }
  } catch (err) {
    logRouteError(err);
    internalError(res);
    return;
  }

  let body: unknown;
  if (rawBody !== undefined) {
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      // Preserved behavior: malformed JSON is an internal error at this
      // boundary (previously it threw inside the async route wrapper).
      logRouteError(err);
      internalError(res);
      return;
    }
  }

  const ctx: AgentApiRouteContext = {
    req, res, params, query: target.query,
    ...(caller !== undefined ? { caller } : {}),
    ...(body !== undefined ? { body } : {}),
  };

  try {
    await route.handler(ctx);
  } catch (err) {
    logRouteError(err);
    internalError(res);
  }
}

function logRouteError(err: unknown): void {
  logWarn("agent-api", `Route error: ${err instanceof Error ? err.message : String(err)}`);
}

function logAndReject(res: ServerResponse, msg: string): void {
  logWarn("agent-api", msg);
  res.writeHead(500, { "Content-Type": "application/json" })
    .end(JSON.stringify(openaiError("Internal server error", "server_error")));
}
