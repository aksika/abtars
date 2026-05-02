import { logAndSwallow } from "./log-and-swallow.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac, randomBytes } from "crypto";
import { abtarsHome } from "../paths.js";
import { AgentApiConfig } from "./agent-api-config.js";
import type { IMemorySystem } from "abmind";
import { scanForInjection } from "abmind";
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
  private authenticated = false;
  private pendingChallenge: string | null = null;

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
    this.authenticated = false;
    this.pendingChallenge = null;
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

  private hmac(data: string): string {
    return createHmac("sha256", this.config.token).update(data).digest("hex");
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

    // ── /api/agent/* (deprecated — still functional with Sunset header) ───
    if (method === "POST" && url === "/api/agent/prompt") {
      this.addDeprecationHeaders(res);
      this.handleMessage(req, res).catch((err) => {
        logWarn(TAG, `Prompt error: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(500).end(JSON.stringify({ error: "internal" }));
      });
    } else if (method === "POST" && url === "/api/agent/reset") {
      this.addDeprecationHeaders(res);
      this.handleReset(res).catch(() => res.writeHead(500).end());
    } else if (method === "GET" && url === "/api/agent/status") {
      this.addDeprecationHeaders(res);
      this.handleStatus(res);
    } else {
      res.writeHead(404).end();
    }
  }

  /**
   * #373 — require bearer token on /v1/* routes. Also allowed as alternative
   * auth on deprecated /api/agent/* routes, but that path keeps the HMAC flow
   * too. Returns true if authorized, writes 401 + returns false otherwise.
   */
  private requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
    const token = extractBearerToken(req.headers as Record<string, string | string[] | undefined>);
    if (!token || token !== this.config.token) {
      const body = JSON.stringify(openaiError("Missing or invalid bearer token", "authentication_error", "invalid_api_key"));
      res.writeHead(401, { "Content-Type": "application/json" }).end(body);
      return false;
    }
    return true;
  }

  /**
   * #373 — add Deprecation + Sunset headers to /api/agent/* responses.
   * Removal tracked by #374 after Molty migrates to /v1/*.
   */
  private addDeprecationHeaders(res: ServerResponse): void {
    res.setHeader("Deprecation", "true");
    // Sunset date: 30 days from now (kept as a header hint; actual deletion gated on #374)
    const sunset = new Date(Date.now() + 30 * 86400000).toUTCString();
    res.setHeader("Sunset", sunset);
    res.setHeader("Link", '<https://github.com/aksika/abtars/blob/dev/docs/openai-compat.md>; rel="deprecation"');
  }

  /** #373 — /v1/chat/completions dispatch. */
  private async handleV1ChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Invalid JSON body", "invalid_request_error", "invalid_body")));
      return;
    }

    let session: AgentSession;
    try {
      session = await this.ensureAgentSession();
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify(openaiError("Failed to spawn agent kiro-cli", "server_error", "spawn_failed")));
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

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req));
    const type = body.type as string | undefined;

    if (type === "hello") return this.handleHello(body, res);
    if (type === "hello-ack") return this.handleHelloAck(body, res);
    if (type === "close") return this.handleClose(res);

    // Normal prompt — auth required if token is configured
    if (this.config.token && !this.authenticated) {
      // Rude guest: respond with KP's hello + challenge, don't process yet
      const challenge = randomBytes(32).toString("hex");
      this.pendingChallenge = challenge;
      logWarn(TAG, `Prompt without hello from unauthenticated guest — sending challenge`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        hello: { name: "KP", challenge },
        error: "hello_required",
        message: "Hello, I'm KP. Who are you? Please authenticate.",
      }));
      return;
    }
    return this.handlePrompt(body, req, res);
  }

  private handleHello(body: Record<string, unknown>, res: ServerResponse): void {
    const name = typeof body.name === "string" ? body.name.slice(0, 15) : "GUEST";
    const guestChallenge = typeof body.challenge === "string" ? body.challenge : null;
    this.guestName = name;

    if (!this.config.token) {
      // No auth configured — just exchange names
      this.authenticated = true;
      logInfo(TAG, `Hello from [${name}] (no auth required)`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        type: "hello", name: "KP",
      }));
      return;
    }

    // Challenge-response: respond to guest's challenge, send our own
    const kpChallenge = randomBytes(32).toString("hex");
    this.pendingChallenge = kpChallenge;
    const responseHmac = guestChallenge ? this.hmac(guestChallenge) : undefined;
    logInfo(TAG, `Hello from [${name}] — challenge exchange`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      type: "hello", name: "KP",
      ...(responseHmac ? { response: responseHmac } : {}),
      challenge: kpChallenge,
    }));
  }

  private handleHelloAck(body: Record<string, unknown>, res: ServerResponse): void {
    const response = typeof body.response === "string" ? body.response : "";
    if (!this.pendingChallenge || response !== this.hmac(this.pendingChallenge)) {
      logWarn(TAG, `Hello-ack failed from [${this.guestName}] — bad HMAC`);
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "auth_failed" }));
      return;
    }
    this.authenticated = true;
    this.pendingChallenge = null;
    logInfo(TAG, `Authenticated: [${this.guestName}]`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private async handleClose(res: ServerResponse): Promise<void> {
    logInfo(TAG, `Session closed by [${this.guestName}]`);
    await this.killAgentSession();
    this.guestName = "GUEST";
    this.authenticated = false;
    this.pendingChallenge = null;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private async handlePrompt(body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt: "", response: "400: prompt required", durationMs: Date.now() - start, status: 400 });
      res.writeHead(400).end(JSON.stringify({ error: "prompt required" }));
      return;
    }

    // Scan for prompt injection before touching kiro-cli
    const scan = scanForInjection(prompt);
    if (!scan.safe) {
      const top = scan.flags[0]!;
      const refusal = `I can't process this request as phrased — it triggered a security filter (${top.category}). Please rephrase your request without instructions that could be interpreted as prompt injection or system access commands.`;
      logWarn(TAG, `BLOCKED ${ip}: ${top.category} — "${top.pattern}"`);
      this.log("BLOCKED", `${top.category}: ${top.pattern}`);
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt, response: `blocked: ${top.category}`, durationMs: Date.now() - start, status: 200 });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response: refusal, sessionKey: this.config.sessionKey }));
      return;
    }

    let t: AgentSession;
    try {
      t = await this.ensureAgentSession();
    } catch (err) {
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt, response: "503: spawn failed", durationMs: Date.now() - start, status: 503 });
      res.writeHead(503).end(JSON.stringify({ error: "failed to spawn agent kiro-cli" }));
      return;
    }

    const { sessionKey } = this.config;

    // Record user message
    this.memory?.recordMessage({ role: "user", content: prompt, timestamp: Date.now(), userId: "master", sessionId: sessionKey });

    const fullPrompt = this.agentRules && !this.rulesInjected
      ? `[AGENT RULES]\n${this.agentRules}\n[END AGENT RULES]\n\n${prompt}`
      : prompt;
    if (this.agentRules && !this.rulesInjected) this.rulesInjected = true;
    this.log(`[${this.guestName}]`, prompt);
    const response = await t.sendPrompt(sessionKey, fullPrompt);

    // Record assistant message
    this.memory?.recordMessage({ role: "assistant", content: response, timestamp: Date.now(), userId: "master", sessionId: sessionKey });

    this.log("[KP]", response);

    this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt: prompt, response: response, durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response, sessionKey }));
  }

  private async handleReset(res: ServerResponse): Promise<void> {
    const start = Date.now();
    this.killAgentSession();
    this.log("SYSTEM", "Session reset");
    this.pushTraffic({ ts: start, ip: "", endpoint: "reset", prompt: "", response: "ok", durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private handleStatus(res: ServerResponse): void {
    const start = Date.now();
    const ready = this.agentSession?.isReady ?? false;
    this.pushTraffic({ ts: start, ip: "", endpoint: "status", prompt: "", response: `ready=${ready}`, durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ready,
      sessionKey: this.config.sessionKey,
      chatId: this.config.chatId,
      hasProcess: this.agentSession !== null,
    }));
  }
}
