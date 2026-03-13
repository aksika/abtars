import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AgentApiConfig } from "./agent-api-config.js";
import { IKiroTransport } from "./kiro-transport.js";
import { MemoryManager } from "./memory-manager.js";
import { logWarn } from "./logger.js";

const TAG = "agent-api";
const MAX_TRAFFIC_LOG = 50;

export interface TrafficEntry {
  ts: number;
  ip: string;
  endpoint: string;
  promptSnippet: string;
  responseSnippet: string;
  durationMs: number;
  status: number;
}

interface AgentApiDeps {
  config: AgentApiConfig;
  transport: () => IKiroTransport;
  memory: MemoryManager | null;
}

function normalizeIp(raw: string): string {
  // Strip IPv4-mapped IPv6 prefix
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
  private transport: () => IKiroTransport;
  private memory: MemoryManager | null;
  private trafficLog: TrafficEntry[] = [];
  private agentRules: string;
  private rulesInjected = false;
  private logDir: string;
  private logFile: string;

  constructor(deps: AgentApiDeps) {
    this.config = deps.config;
    this.transport = deps.transport;
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
    return new Promise((resolve) => this.server.close(() => resolve()));
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
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", promptSnippet: "", responseSnippet: "400: prompt required", durationMs: Date.now() - start, status: 400 });
      res.writeHead(400).end(JSON.stringify({ error: "prompt required" }));
      return;
    }

    const { sessionKey, chatId } = this.config;
    const t = this.transport();

    if (!t.isReady) {
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", promptSnippet: prompt.slice(0, 80), responseSnippet: "503: transport not ready", durationMs: Date.now() - start, status: 503 });
      res.writeHead(503).end(JSON.stringify({ error: "transport not ready" }));
      return;
    }

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

    this.pushTraffic({ ts: start, ip, endpoint: "prompt", promptSnippet: prompt.slice(0, 80), responseSnippet: response.slice(0, 120), durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response, sessionKey }));
  }

  private async handleReset(res: ServerResponse): Promise<void> {
    const start = Date.now();
    await this.transport().resetSession(this.config.sessionKey);
    this.rulesInjected = false;
    this.log("SYSTEM", "Session reset");
    this.logFile = this.newLogFile();
    this.pushTraffic({ ts: start, ip: "", endpoint: "reset", promptSnippet: "", responseSnippet: "ok", durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private handleStatus(res: ServerResponse): void {
    const start = Date.now();
    const t = this.transport();
    this.pushTraffic({ ts: start, ip: "", endpoint: "status", promptSnippet: "", responseSnippet: `ready=${t.isReady}`, durationMs: Date.now() - start, status: 200 });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ready: t.isReady,
      sessionKey: this.config.sessionKey,
      chatId: this.config.chatId,
    }));
  }
}
