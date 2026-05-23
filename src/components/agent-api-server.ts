import { logAndSwallow } from "./log-and-swallow.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import { createHash } from "crypto";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { abtarsHome } from "../paths.js";
import { AgentApiConfig } from "./agent-api-config.js";
import type { IMemorySystem } from "abmind";
import { logInfo, logWarn } from "./logger.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { AgentSession } from "./subagent-runtime.js";
import { localDate } from "../utils/date.js";
import { localIso } from "./logger.js";
import { extractBearerToken, openaiError } from "./openai-compat-translate.js";
import { handleModels as v1HandleModels, handleModel as v1HandleModel, handleEmbeddings as v1HandleEmbeddings, handleChatCompletions as v1HandleChatCompletions, writeResult } from "./openai-compat-routes.js";

const TAG = "agent-api";
const MAX_TRAFFIC_LOG = 50;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface TrafficEntry {
  ts: number;
  ip: string;
  endpoint: string;
  prompt: string;
  response: string;
  durationMs: number;
  status: number;
}

interface AgentApiDeps {
  config: AgentApiConfig;
  cliPath: string;
  workingDir: string;
  memory: IMemorySystem | null;
  runtime: SubagentRuntime;
  /** Optional callback for peer activity notifications (A2A). */
  onPeerActivity?: (msg: string) => void;
}

function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/, "");
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export class AgentApiServer {
  private server!: ReturnType<typeof import("node:http").createServer>;
  private config: AgentApiConfig;
  private workingDir: string;
  private memory: IMemorySystem | null;
  private trafficLog: TrafficEntry[] = [];
  private agentRules: string;
  private rulesInjected = false;
  private logDir: string;
  private logFile: string;
  private agentSession: AgentSession | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private runtime: SubagentRuntime;
  private guestName = "GUEST";
  private onPeerActivity?: (msg: string) => void;

  constructor(deps: AgentApiDeps) {
    this.config = deps.config;
    this.workingDir = deps.workingDir;
    this.memory = deps.memory;
    this.runtime = deps.runtime;
    this.onPeerActivity = deps.onPeerActivity;

    // Use HTTPS with TLS-PSK if any peer has pskSecret configured
    let hasPsk = false;
    try {
      const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
      const peerConfig = loadPeerConfig();
      hasPsk = Object.values(peerConfig.peers).some(p => p.pskSecret);
      if (hasPsk) {
        this.server = createHttpsServer({
          minVersion: "TLSv1.3",
          ciphers: "TLS_AES_256_GCM_SHA384",
          pskCallback: (_socket: unknown, identity: string | null) => {
            if (!identity) return null;
            const peer = Object.entries(peerConfig.peers).find(([name]) => name === identity);
            if (!peer?.[1].pskSecret) return null;
            return { psk: createHash("sha384").update(peer[1].pskSecret).digest(), identity };
          },
        } as any, (req: IncomingMessage, res: ServerResponse) => this.handle(req, res));
        logInfo(TAG, "TLS-PSK enabled for agent-api");
      }
    } catch {}
    if (!hasPsk) {
      this.server = createServer((req, res) => this.handle(req, res));
    }

    this.logDir = join(abtarsHome(), "logs", "agents");
    mkdirSync(this.logDir, { recursive: true });
    this.logFile = this.newLogFile();
    try {
      const base = dirname(fileURLToPath(import.meta.url));
      const name = deps.config.agentCodename;
      const candidates = [
        join(base, `../../agents/${name}.md`),
        join(abtarsHome(), "agents", `${name}.md`),
      ];
      this.agentRules = "";
      for (const p of candidates) {
        try { this.agentRules = readFileSync(p, "utf8"); break; } catch (err) { logAndSwallow("agent_api_server", "op", err); }
      }
    } catch {
      this.agentRules = "";
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", (err: NodeJS.ErrnoException) => reject(err));
      this.server.listen(this.config.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await this.killAgentSession();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Get or create a dedicated agent session for A2A. */
  private async ensureAgentSession(): Promise<AgentSession> {
    if (this.agentSession?.isReady) {
      this.resetIdleTimer();
      return this.agentSession;
    }
    this.agentSession = await this.runtime.session("browsie");
    this.resetIdleTimer();
    return this.agentSession;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.killAgentSession(), IDLE_TIMEOUT_MS);
  }

  private async killAgentSession(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.agentSession) return;
    logInfo(TAG, "A2A idle timeout — saving chat, closing log, killing session");
    try {
      const today = localDate();
      const dir = join(this.workingDir, "memory", "working", today);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "transcript_a2a.chat");
      await this.agentSession.sendPrompt("a2a:save", `/chat save ${dest}`);
      logInfo(TAG, `A2A chat saved to ${dest}`);
    } catch (e) {
      logWarn(TAG, `A2A chat save failed: ${e}`);
    }
    this.log("SYSTEM", "Idle timeout — session closed");
    await this.agentSession.destroy();
    this.agentSession = null;
    this.rulesInjected = false;
    this.guestName = "GUEST";
    this.logFile = this.newLogFile();
  }

  getTrafficLog(): TrafficEntry[] {
    return this.trafficLog;
  }

  private pushTraffic(entry: TrafficEntry): void {
    this.trafficLog.push(entry);
    if (this.trafficLog.length > MAX_TRAFFIC_LOG) this.trafficLog.shift();
  }

  private newLogFile(): string {
    const ts = localIso().replace(/[:.]/g, "-");
    const name = this.config.agentCodename;
    return join(this.logDir, `${name}_${ts}.log`);
  }

  private log(role: string, content: string): void {
    const ts = localIso();
    appendFileSync(this.logFile, `[${ts}] ${role}: ${content}\n`);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {

    const url = req.url ?? "";
    const method = req.method ?? "";

    // ── /v1/* routes (#373) ───────────────────────────────────────────────
    if (url === "/v1/models" && method === "GET") {
      if (this.requireBearer(req, res) === null) return;
      writeResult(res, v1HandleModels());
      return;
    }
    if (url.startsWith("/v1/models/") && method === "GET") {
      if (this.requireBearer(req, res) === null) return;
      const id = decodeURIComponent(url.slice("/v1/models/".length));
      writeResult(res, v1HandleModel(id));
      return;
    }
    if (url === "/v1/chat/completions" && method === "POST") {
      const caller = this.requireBearer(req, res);
      if (caller === null) return;
      this.guestName = caller;
      this.handleV1ChatCompletions(req, res, caller).catch((err) => {
        logWarn(TAG, `/v1/chat/completions error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" })
            .end(JSON.stringify(openaiError("Internal server error", "server_error")));
        }
      });
      return;
    }
    if (url === "/v1/embeddings" && method === "POST") {
      if (this.requireBearer(req, res) === null) return;
      this.handleV1Embeddings(req, res).catch((err) => {
        logWarn(TAG, `/v1/embeddings error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" })
            .end(JSON.stringify(openaiError("Internal server error", "server_error")));
        }
      });
      return;
    }

    res.writeHead(404).end();
  }

  /**
   * #373 — require bearer token on /v1/* routes.
   * Returns true if authorized, writes 401 + returns false otherwise.
   */
  private requireBearer(req: IncomingMessage, res: ServerResponse): string | null {
    const token = extractBearerToken(req.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Missing bearer token", "authentication_error", "invalid_api_key")));
      return null;
    }
    // JWT auth via peers.json — verify signature, return caller identity.
    const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
    const { verifyJwt } = require("./peer-jwt.js") as typeof import("./peer-jwt.js");
    const config = loadPeerConfig();

    // Try JWT verification against each peer's secret
    for (const [name, peer] of Object.entries(config.peers)) {
      const result = verifyJwt(token, peer.token, config.self.name);
      if (result.ok && result.payload.iss === name) {
        logInfo(TAG, `PEER_CALL iss=${result.payload.iss} aud=${result.payload.aud} verified`);
        return result.payload.iss;
      }
    }

    // Fallback: raw token match (backward compat during migration)
    for (const [name, peer] of Object.entries(config.peers)) {
      if (token === peer.token) {
        logInfo(TAG, `PEER_CALL caller=${name} (raw token, no JWT)`);
        return name;
      }
    }

    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify(openaiError("Invalid bearer token", "authentication_error", "invalid_api_key")));
    return null;
  }

  /** #373 — /v1/chat/completions dispatch. */
  private async handleV1ChatCompletions(req: IncomingMessage, res: ServerResponse, caller: string): Promise<void> {
    const start = Date.now();
    const ip = normalizeIp(req.socket.remoteAddress ?? "");

    // #392 — hop check. If X-Peer-Hops header is present and value is 0, refuse.
    // If absent, this is a direct call (not forwarded) — always allow.
    const hopHeader = req.headers["x-peer-hops"];
    const hopValue = typeof hopHeader === "string" ? parseInt(hopHeader, 10) : null;
    if (hopValue !== null && hopValue <= 0) {
      res.writeHead(429, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Peer hop limit reached", "loop_detected", "hop_exceeded")));
      return;
    }
    // Set module-level hop state so peer_session tool knows the budget for outbound calls
    const { setCurrentPeerHops } = await import("./peer-client.js");
    setCurrentPeerHops(hopValue);

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Invalid JSON body", "invalid_request_error", "invalid_body")));
      setCurrentPeerHops(null);
      return;
    }

    // #416 — Verify digital signature on incoming peer message
    let commsType: "signed" | "plain" | "sig-invalid" = "plain";
    const reqMessages = (body as { messages?: Array<{ content?: string }> }).messages;
    const lastMsg = reqMessages?.[reqMessages.length - 1];
    if (lastMsg?.content) {
      const { verifyMessage } = await import("./digital-signature.js");
      const { loadPeerConfig } = await import("./peer-config.js");
      const peerConfig = loadPeerConfig();
      const peerEntry = peerConfig.peers[caller];
      const hasSigTag = /\[sig:\d+:[A-Za-z0-9+/=]+\]$/.test(lastMsg.content);

      if (hasSigTag && peerEntry?.verifyKey) {
        const result = verifyMessage(peerEntry.verifyKey, caller, peerConfig.self.name, lastMsg.content);
        commsType = result.valid ? "signed" : "sig-invalid";
        if (result.valid) lastMsg.content = result.text; // strip sig tag from content
      } else if (peerEntry?.mode === "signed" && !hasSigTag) {
        // Reject unsigned message when mode requires signing
        logWarn(TAG, `Rejected unsigned message from ${caller} (mode=signed)`);
        res.writeHead(403, { "Content-Type": "application/json" })
          .end(JSON.stringify(openaiError("Signature required", "authentication_error", "signature_missing")));
        setCurrentPeerHops(null);
        this.onPeerActivity?.(`🤖 Agents: ${caller} → ${this.config.agentCodename} [rejected ⚠️ no signature]`);
        return;
      }
      if (commsType === "sig-invalid" && peerEntry?.mode === "signed") {
        logWarn(TAG, `Rejected invalid signature from ${caller}`);
        res.writeHead(403, { "Content-Type": "application/json" })
          .end(JSON.stringify(openaiError("Invalid signature", "authentication_error", "signature_invalid")));
        setCurrentPeerHops(null);
        this.onPeerActivity?.(`🤖 Agents: ${caller} → ${this.config.agentCodename} [rejected ⚠️ invalid sig]`);
        return;
      }
    }

    // [NO-REPLY] filter — peer signaled no response needed (#421)
    if (lastMsg?.content && /\[NO-REPLY\]/i.test(lastMsg.content)) {
      logInfo(TAG, `Peer ${caller} sent [NO-REPLY] — returning empty completion`);
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ id: "no-reply", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] }));
      setCurrentPeerHops(null);
      return;
    }

    // Callback mechanism (#451) — peer called back after our callback request
    if (lastMsg?.content?.startsWith("callback")) {
      const { hasPending, popPendingPrompt } = await import("./pending-callback.js");
      if (hasPending(caller)) {
        const pendingPrompt = popPendingPrompt(caller);
        logInfo(TAG, `Callback from ${caller} — returning pending prompt (${pendingPrompt?.length ?? 0} chars)`);
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ id: "cb", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: pendingPrompt ?? "" }, finish_reason: "stop" }] }));
        setCurrentPeerHops(null);
        return;
      }
    }

    // CB-RESPONSE — peer delivering answer to our pending callback (#451)
    if (lastMsg?.content?.startsWith("[CB-RESPONSE]")) {
      const { resolvePending } = await import("./pending-callback.js");
      const answer = lastMsg.content.slice("[CB-RESPONSE]".length).trim();
      if (resolvePending(caller, answer)) {
        logInfo(TAG, `CB-RESPONSE from ${caller} — resolved pending (${answer.length} chars)`);
      }
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ id: "cb-ack", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] }));
      setCurrentPeerHops(null);
      return;
    }

    logInfo(TAG, `Peer call: ${caller} → ${this.config.agentCodename} [${commsType}]`);
    this.onPeerActivity?.(`🤖 Agents: ${caller} → ${this.config.agentCodename} [${commsType}]`);

    let session: AgentSession;
    try {
      session = await this.ensureAgentSession();
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Failed to spawn agent kiro-cli", "server_error", "spawn_failed")));
      setCurrentPeerHops(null);
      return;
    }

    const result = await v1HandleChatCompletions(body, req, {
      session,
      memory: this.memory,
      agentRules: this.agentRules,
      rulesAlreadyInjected: this.rulesInjected,
      markRulesInjected: () => { this.rulesInjected = true; },
      guestName: this.guestName,
    });

    // Reflect traffic log for observability
    const reqBody = body as { messages?: unknown[] };
    const promptPreview = Array.isArray(reqBody.messages) && reqBody.messages.length > 0
      ? String((reqBody.messages[reqBody.messages.length - 1] as { content?: unknown })?.content ?? "").slice(0, 200)
      : "";
    this.pushTraffic({
      ts: start,
      ip,
      endpoint: "v1/chat/completions",
      prompt: promptPreview,
      response: result.streaming ? "[streamed]" : result.body.slice(0, 200),
      durationMs: Date.now() - start,
      status: result.status,
    });

    res.writeHead(result.status, result.headers);
    res.end(result.body);
    setCurrentPeerHops(null); // clear hop state after request completes
  }

  /** #373 — /v1/embeddings dispatch. */
  private async handleV1Embeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Invalid JSON body", "invalid_request_error", "invalid_body")));
      return;
    }
    const result = await v1HandleEmbeddings(body, this.memory);
    writeResult(res, result);
  }

}
