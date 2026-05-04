import { logAndSwallow } from "./log-and-swallow.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { abtarsHome } from "../paths.js";
import { AgentApiConfig } from "./agent-api-config.js";
import type { IMemorySystem } from "abmind";
import { logInfo, logWarn } from "./logger.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { AgentSession } from "./subagent-runtime.js";
import { localDate } from "./env-utils.js";
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
  private server;
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

  constructor(deps: AgentApiDeps) {
    this.config = deps.config;
    this.workingDir = deps.workingDir;
    this.memory = deps.memory;
    this.runtime = deps.runtime;
    this.server = createServer((req, res) => this.handle(req, res));
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
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          logWarn(TAG, `Port ${this.config.port} already in use — attempting self-heal`);
          import("node:child_process").then(({ execSync }) => {
            try {
              const pid = execSync(`lsof -i :${this.config.port} -t`, { encoding: "utf-8", timeout: 3000 }).trim();
              if (pid && pid !== String(process.pid)) {
                process.kill(parseInt(pid, 10), "SIGTERM");
                logInfo(TAG, `Killed zombie PID ${pid} holding port ${this.config.port}`);
                setTimeout(() => {
                  this.server.listen(this.config.port, () => {
                    logInfo(TAG, `Agent API listening on port ${this.config.port} (after self-heal)`);
                    resolve();
                  });
                }, 1000);
                return;
              }
            } catch { /* lsof/kill failed */ }
            reject(err);
          }).catch(() => reject(err));
          return;
        }
        reject(err);
      });
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
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    if (ip !== "127.0.0.1" && ip !== "::1" && !this.config.allowedIps.includes(ip)) {
      logWarn(TAG, `Rejected connection from ${ip}`);
      res.writeHead(403).end();
      return;
    }

    const url = req.url ?? "";
    const method = req.method ?? "";

    // ── /v1/* routes (#373) ───────────────────────────────────────────────
    if (url === "/v1/models" && method === "GET") {
      if (!this.requireBearer(req, res)) return;
      writeResult(res, v1HandleModels());
      return;
    }
    if (url.startsWith("/v1/models/") && method === "GET") {
      if (!this.requireBearer(req, res)) return;
      const id = decodeURIComponent(url.slice("/v1/models/".length));
      writeResult(res, v1HandleModel(id));
      return;
    }
    if (url === "/v1/chat/completions" && method === "POST") {
      if (!this.requireBearer(req, res)) return;
      this.handleV1ChatCompletions(req, res).catch((err) => {
        logWarn(TAG, `/v1/chat/completions error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" })
            .end(JSON.stringify(openaiError("Internal server error", "server_error")));
        }
      });
      return;
    }
    if (url === "/v1/embeddings" && method === "POST") {
      if (!this.requireBearer(req, res)) return;
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
  private requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
    const token = extractBearerToken(req.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Missing bearer token", "authentication_error", "invalid_api_key")));
      return false;
    }
    // All auth via peers.json — each entry (peer or operator client) has its own token.
    const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
    const peers = loadPeerConfig().peers;
    for (const peer of Object.values(peers)) {
      if (token === peer.token) return true;
    }
    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify(openaiError("Invalid bearer token", "authentication_error", "invalid_api_key")));
    return false;
  }

  /** #373 — /v1/chat/completions dispatch. */
  private async handleV1ChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    // Set module-level hop state so peer_ask tool knows the budget for outbound calls
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
