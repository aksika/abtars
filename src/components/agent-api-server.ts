import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac, randomBytes } from "crypto";
import { AgentApiConfig } from "./agent-api-config.js";
import { IKiroTransport } from "./kiro-transport.js";
import { AcpTransport } from "./acp-transport.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { scanPrompt } from "./prompt-scanner.js";
import { logInfo, logWarn } from "./logger.js";
import { localDate } from "./env-utils.js";
import { localIso } from "./logger.js";

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
  private guestName = "GUEST";
  private authenticated = false;
  private pendingChallenge: string | null = null;

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
      const today = localDate();
      const dir = join(this.workingDir, "memory", "working", today);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "transcript_a2a.chat");
      await this.agentTransport.sendPrompt("a2a:save", `/chat save ${dest}`);
      logInfo(TAG, `A2A chat saved to ${dest}`);
    } catch (e) {
      logWarn(TAG, `A2A chat save failed: ${e}`);
    }
    this.log("SYSTEM", "Idle timeout — session closed");
    this.agentTransport.destroy();
    this.agentTransport = null;
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

    if (method === "POST" && url === "/api/agent/prompt") {
      this.handleMessage(req, res).catch((err) => {
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
    await this.killAgentTransport();
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
    const hit = scanPrompt(prompt);
    if (hit) {
      const refusal = `I can't process this request as phrased — it triggered a security filter (${hit.patternId}). Please rephrase your request without instructions that could be interpreted as prompt injection or system access commands.`;
      logWarn(TAG, `BLOCKED ${ip}: ${hit.patternId} — "${hit.matched}"`);
      this.log("BLOCKED", `${hit.patternId}: ${hit.matched}`);
      this.pushTraffic({ ts: start, ip, endpoint: "prompt", prompt, response: `blocked: ${hit.patternId}`, durationMs: Date.now() - start, status: 200 });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response: refusal, sessionKey: this.config.sessionKey }));
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
    this.log(`[${this.guestName}]`, prompt);
    const response = await t.sendPrompt(sessionKey, fullPrompt);

    // Record assistant message
    this.memory?.recordMessage({ role: "assistant", content: response, timestamp: Date.now(), chatId, sessionId: sessionKey });

    this.log("[KP]", response);

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
