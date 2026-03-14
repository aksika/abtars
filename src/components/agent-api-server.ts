import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AgentApiConfig } from "./agent-api-config.js";
import { IKiroTransport } from "./kiro-transport.js";
import { AcpTransport } from "./acp-transport.js";
import { MemoryManager } from "./memory-manager.js";
import { logInfo, logWarn } from "./logger.js";

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
  memory: MemoryManager | null;
}

function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/, "");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export class AgentApiServer {
  private server;
  private config: AgentApiConfig;
  private cliPath: string;
  private workingDir: string;
  private memory: MemoryManager | null;
  private trafficLog: TrafficEntry[] = [];
  private agentRules: string;
  private rulesInjected = false;
  private logDir: string;
  private logFile: string;
  private agentTransport: AcpTransport | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: AgentApiDeps) {
    this.config = deps.config;
    this.cliPath = deps.cliPath;
    this.workingDir = deps.workingDir;
    this.memory = deps.memory;
    this.server = createServer((req, res) => this.handle(req, res));
    this.logDir = join(process.env.HOME ?? "", ".agentbridge/logs/agents");
    mkdirSync(this.logDir, { recursive: true });
    this.logFile = this.newLogFile();
    try {
      const base = dirname(fileURLToPath(import.meta.url));
      const name = deps.config.agentCodename;
      const candidates = [
        join(base, `../../skills/agents/${name}.md`),
        join(process.env.HOME ?? "", `.agentbridge/skills/agents/${name}.md`),
      ];
      this.agentRules = "";
      for (const p of candidates) {
        try { this.agentRules = readFileSync(p, "utf8"); break; } catch { /* next */ }
      }
    } catch {
      this.agentRules = "";
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.killAgentTransport();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Spawn a dedicated kiro-cli ACP process for A2A. No --agent flag (no SOUL needed). */
  private async ensureAgentTransport(): Promise<AcpTransport> {
    if (this.agentTransport?.isReady) {
      this.resetIdleTimer();
      return this.agentTransport;
    }
    logInfo(TAG, "Spawning dedicated kiro-cli for A2A");
    this.agentTransport = new AcpTransport(this.cliPath, this.workingDir, { skipAgent: true });
    await this.agentTransport.initialize();
    this.resetIdleTimer();
    return this.agentTransport;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.killAgentTransport(), IDLE_TIMEOUT_MS);
  }

  private async killAgentTransport(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.agentTransport) return;
    logInfo(TAG, "A2A idle timeout — saving chat, closing log, killing kiro-cli");
    // Save conversation before destroying
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dir = join(this.workingDir, "memory", "working", today);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "transcript_a2a.md");
      await this.agentTransport.sendPrompt("a2a:save", `/chat save ${dest}`);
      logInfo(TAG, `A2A chat saved to ${dest}`);
    } catch (e) {
      logWarn(TAG, `A2A chat save failed: ${e}`);
    }
    this.log("SYSTEM", "Idle timeout — session closed");
    this.agentTransport.destroy();
    this.agentTransport = null;
    this.rulesInjected = false;
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
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = this.config.agentCodename;
    return join(this.logDir, `${name}_${ts}.log`);
  }

  private log(role: string, content: string): void {
    const ts = new Date().toISOString();
    appendFileSync(this.logFile, `[${ts}] ${role}: ${content}\n`);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    if (ip !== "127.0.0.1" && ip !== "::1" && !this.config.allowedIps.includes(ip)) {
      logWarn(TAG, `Rejected connection from ${ip}`);
      res.writeHead(403).end();
      return;
    }
    if (this.config.token && req.headers["authorization"] !== `Bearer ${this.config.token}`) {
      res.writeHead(401).end();
      return;
    }

    const url = req.url ?? "";
    const method = req.method ?? "";

    if (method === "POST" && url === "/api/agent/prompt") {
      this.handlePrompt(req, res).catch((err) => {
        logWarn(TAG, `Prompt error: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(500).end(JSON.stringify({ error: "internal" }));
      });
    } else if (method === "POST" && url === "/api/agent/reset") {
      this.handleReset(res).catch(() => res.writeHead(500).end());
    } else if (method === "GET" && url === "/api/agent/status") {
      this.handleStatus(res);
    } else {
      res.writeHead(404).end();
    }
  }

  private async handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    const body = JSON.parse(await readBody(req));
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt: "", response: "400: prompt required", durationMs: Date.now() - start, status: 400 });
      res.writeHead(400).end(JSON.stringify({ error: "prompt required" }));
      return;
    }

    let t: IKiroTransport;
    try {
      t = await this.ensureAgentTransport();
    } catch (err) {
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt, response: "503: spawn failed", durationMs: Date.now() - start, status: 503 });
      res.writeHead(503).end(JSON.stringify({ error: "failed to spawn agent kiro-cli" }));
      return;
    }

    const { sessionKey, chatId } = this.config;

    // Record user message
    this.memory?.recordMessage({ role: "user", content: prompt, timestamp: Date.now(), chatId, sessionId: sessionKey });

    const fullPrompt = this.agentRules && !this.rulesInjected
      ? `[AGENT RULES]\n${this.agentRules}\n[END AGENT RULES]\n\n${prompt}`
      : prompt;
    if (this.agentRules && !this.rulesInjected) this.rulesInjected = true;
    this.log("USER", prompt);
    const response = await t.sendPrompt(sessionKey, fullPrompt);

    // Record assistant message
    this.memory?.recordMessage({ role: "assistant", content: response, timestamp: Date.now(), chatId, sessionId: sessionKey });

    this.log("ASSISTANT", response);

    this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt: prompt, response: response, durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response, sessionKey }));
  }

  private async handleReset(res: ServerResponse): Promise<void> {
    const start = Date.now();
    this.killAgentTransport();
    this.log("SYSTEM", "Session reset");
    this.pushTraffic({ ts: start, ip: "", endpoint: "reset", prompt: "", response: "ok", durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private handleStatus(res: ServerResponse): void {
    const start = Date.now();
    const ready = this.agentTransport?.isReady ?? false;
    this.pushTraffic({ ts: start, ip: "", endpoint: "status", prompt: "", response: `ready=${ready}`, durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ready,
      sessionKey: this.config.sessionKey,
      chatId: this.config.chatId,
      hasProcess: this.agentTransport !== null,
    }));
  }
}
