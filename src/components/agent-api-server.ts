import { createServer, IncomingMessage, ServerResponse } from "http";
import { AgentApiConfig } from "./agent-api-config.js";
import { IKiroTransport } from "./kiro-transport.js";
import { MemoryManager } from "./memory-manager.js";
import { logWarn } from "./logger.js";

const TAG = "agent-api";

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

  constructor(deps: AgentApiDeps) {
    this.config = deps.config;
    this.transport = deps.transport;
    this.memory = deps.memory;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, "0.0.0.0", () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    if (!this.config.allowedIps.includes(ip)) {
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
    const body = JSON.parse(await readBody(req));
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      res.writeHead(400).end(JSON.stringify({ error: "prompt required" }));
      return;
    }

    const { sessionKey, chatId } = this.config;
    const t = this.transport();

    if (!t.isReady) {
      res.writeHead(503).end(JSON.stringify({ error: "transport not ready" }));
      return;
    }

    // Record user message
    this.memory?.recordMessage({ role: "user", content: prompt, timestamp: Date.now(), chatId, sessionId: sessionKey });

    const response = await t.sendPrompt(sessionKey, prompt);

    // Record assistant message
    this.memory?.recordMessage({ role: "assistant", content: response, timestamp: Date.now(), chatId, sessionId: sessionKey });

    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response, sessionKey }));
  }

  private async handleReset(res: ServerResponse): Promise<void> {
    await this.transport().resetSession(this.config.sessionKey);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  }

  private handleStatus(res: ServerResponse): void {
    const t = this.transport();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ready: t.isReady,
      sessionKey: this.config.sessionKey,
      chatId: this.config.chatId,
    }));
  }
}
