/**
 * scripted-provider.ts — #1528 deterministic OpenAI-compatible HTTP/SSE
 * provider. Stands in for the external model service only; the bridge reaches
 * it through the real pi-ai network path.
 *
 * Every request is validated against a scripted semantic expectation BEFORE
 * response headers are written. The provider records content-free summaries
 * (marker hashes, roles, tool names, abort state) — never raw message text.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { ProviderScript, ProviderSummary, RequestExpectation } from "./contracts.js";

const BODY_MAX = 2 * 1024 * 1024;
const CHUNK_MAX = 4096;

interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  toolCalls?: Array<{ name: string; argsText: string }>;
}

export class FixtureExpectationError extends Error {
  readonly code = "fixture_expectation_failed";
  constructor(message: string) {
    super(message);
    this.name = "FixtureExpectationError";
  }
}

export class ScriptedProvider {
  private server: Server;
  private scripts: Map<string, ProviderScript[]> = new Map();
  summaries: ProviderSummary[] = [];
  private seq = 0;
  private port = 0;
  private closed = false;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address === null || typeof address === "object" && "port" in address) {
          this.port = (address as { port: number }).port;
          resolve();
        } else {
          reject(new Error("provider failed to bind a loopback port"));
        }
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get requestCount(): number {
    return this.summaries.length;
  }

  requestCountFor(candidate: string): number {
    return this.summaries.filter((s) => s.candidate === candidate).length;
  }

  summariesFor(candidate: string): ProviderSummary[] {
    return this.summaries.filter((s) => s.candidate === candidate);
  }

  /** Queue the next scripted behavior for a candidate (FIFO per candidate). */
  enqueue(script: ProviderScript): void {
    const queue = this.scripts.get(script.candidate) ?? [];
    queue.push(script);
    this.scripts.set(script.candidate, queue);
  }

  clear(): void {
    this.scripts.clear();
    this.summaries = [];
    this.seq = 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !(url.endsWith("/chat/completions"))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "fixture_not_found" } }));
      return;
    }

    let body: Buffer;
    try {
      body = await readBounded(req);
    } catch (err) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "fixture_body_too_large" } }));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf-8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "fixture_bad_json" } }));
      return;
    }

    const request = this.normalize(payload);
    const summary: ProviderSummary = {
      seq: ++this.seq,
      candidate: request.model,
      action: "unknown",
      aborted: false,
      roleCounts: request.roleCounts,
      toolCalls: request.toolCalls,
      markerHashes: request.markerHashes,
      // Bounded synthetic user-message texts (markers only — the fixture
      // never receives real content) so scenarios can substring-match.
      markerTexts: request.userTexts.map((t) => t.slice(0, 300)),
    };

    const queue = this.scripts.get(request.model);
    // Expectation-aware matching: pop the first script whose expectation
    // fully matches the request (handles interleaved generations from
    // concurrent sessions on the same candidate); fall back to FIFO.
    const script = this.popScript(queue, request);
    if (!script) {
      summary.action = "unscripted";
      this.summaries.push(summary);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { code: "fixture_unscripted_request", message: `no scripted behavior for candidate ${request.model} (seq ${this.seq})` },
      }));
      return;
    }
    summary.action = script.action.kind;

    let expectationError: Error | null = null;
    if (script.expectation) {
      try {
        this.validateExpectation(script.expectation, request);
      } catch (err) {
        expectationError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (expectationError) {
      summary.action = "expectation_failed";
      this.summaries.push(summary);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { code: "fixture_expectation_failed", message: expectationError.message.slice(0, 1000) },
      }));
      return;
    }

    // Observe abort for any action: a request that dies mid-flight is
    // recorded as aborted so the harness can assert network cancellation.
    // The close handler writes the summary directly — the hold action may
    // wait forever on its release, so the post-release finalizer below must
    // not be the only place that records the abort.
    res.on("close", () => {
      if (!res.writableEnded) summary.aborted = true;
    });

    this.summaries.push(summary);

    switch (script.action.kind) {
      case "httpError":
        res.writeHead(script.action.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: script.action.code, message: "fixture transient failure" } }));
        break;
      case "text":
        await this.streamText(res, request.model, script.action.chunks);
        break;
      case "toolCall":
        await this.streamToolCall(res, script.action.name, script.action.arguments);
        break;
      case "hold": {
        // Establish an active STREAMING generation first: Pi's steering only
        // interrupts a generation that is already streaming (the agent must
        // have seen a first delta). A held connection with no data never
        // enters streaming, so a steer instruction is silently dropped and
        // the turn hangs. The initial delta is a synthetic marker-free
        // placeholder the host immediately replaces on steer.
        this.sseStart(res);
        this.sseChunk(res, request.model, "…");
        await script.action.release;
        if (res.writableEnded) {
          summary.aborted = true;
          return;
        }
        // Released while still open — close the generation cleanly so the
        // host can settle and a steering/follow-up continuation can proceed.
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-fixture-${this.seq}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        break;
      }
    case "acquisitionHold": {
        // #1506: simulate a provider whose request/stream NEVER opens — no
        // response headers are ever written, so the client's acquisition
        // promise stays pending with no iterator for any stream watchdog to
        // observe. The executing bridge must bound the attempt itself (abort
        // signal or inactivity deadline). The connection close on abort (or an
        // explicit release) resolves the wait; never a fixed sleep.
        await Promise.race([
          script.action.release,
          new Promise<void>((resolve) => res.once("close", resolve)),
        ]);
        break;
      }
    }

    // Finalize abort state for held connections that died during the wait.
    if ((script.action.kind === "hold" || script.action.kind === "acquisitionHold") && summary.aborted && !res.writableEnded) {
      res.destroy();
    }
  }

  private popScript(queue: ProviderScript[] | undefined, request: ReturnType<ScriptedProvider["normalize"]>): ProviderScript | undefined {
    if (!queue || queue.length === 0) return undefined;
    // Unconstrained scripts (no expectation) are consumed FIFO by the next
    // request on this candidate — the smoke one-shot pattern.
    const unconstrainedIndex = queue.findIndex((s) => !s.expectation);
    if (unconstrainedIndex >= 0) return queue.splice(unconstrainedIndex, 1)[0];
    // Constrained scripts are consumed only by a request whose semantic
    // expectation fully matches. A request that matches nothing (a boot
    // greeting, a fail-closed turn that never reached the provider, or any
    // other unexpected turn) is unscripted and MUST NOT consume queued
    // scripts — otherwise one stray turn mis-pops a later scenario's script
    // and the expectation failure poisons the candidate health registry.
    for (let i = 0; i < queue.length; i++) {
      const script = queue[i]!;
      if (!script.expectation) continue;
      try {
        this.validateExpectation(script.expectation, request);
        return queue.splice(i, 1)[0];
      } catch {
        // not this script — keep looking
      }
    }
    return undefined;
  }

  // ── Request normalization (semantic, content-safe) ────────────────────────

  private normalize(payload: unknown): {
    model: string;
    messages: NormalizedMessage[];
    roleCounts: Record<string, number>;
    toolCalls: string[];
    markerHashes: string[];
    userTexts: string[];
  } {
    const rec = payload as Record<string, unknown>;
    const model = typeof rec["model"] === "string" ? rec["model"] : "unknown";
    const rawMessages = Array.isArray(rec["messages"]) ? rec["messages"] as unknown[] : [];
    const messages: NormalizedMessage[] = [];
    const roleCounts: Record<string, number> = {};
    const toolCalls: string[] = [];

    for (const raw of rawMessages) {
      const m = raw as Record<string, unknown>;
      const role = typeof m["role"] === "string" ? m["role"] : "unknown";
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      if (role === "system") {
        messages.push({ role: "system", text: extractText(m["content"]) });
        continue;
      }
      if (role === "user" || role === "tool") {
        messages.push({ role, text: extractText(m["content"]) });
        continue;
      }
      if (role === "assistant") {
        const toolCallsRaw = m["tool_calls"];
        if (Array.isArray(toolCallsRaw)) {
          const calls = toolCallsRaw
            .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
            .map((c) => {
              const fn = (c["function"] ?? {}) as Record<string, unknown>;
              const name = typeof fn["name"] === "string" ? fn["name"] : "unknown";
              toolCalls.push(name);
              return { name, argsText: typeof fn["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn["arguments"] ?? "") };
            });
          messages.push({ role: "assistant", text: extractText(m["content"]), toolCalls: calls });
        } else {
          messages.push({ role: "assistant", text: extractText(m["content"]) });
        }
        continue;
      }
      messages.push({ role: "user", text: extractText(m["content"]) });
    }

    // Marker hashes normalize away the bridge's prompt decorations (leading
    // `[timestamp]` prefix) so scenarios can wait for their synthetic markers
    // on the augmented current turn. History rows are stored raw and match
    // unchanged. Substring validation below is unaffected.
    const normalizedText = (text: string): string => text.replace(/^\[[^\]]*\]\s*/, "");
    const userTexts = messages
      .filter((m) => m.role === "user")
      .map((m) => normalizedText(m.text));
    const markerHashes = userTexts.map((t) => createHash("sha256").update(t).digest("hex").slice(0, 16));

    return { model, messages, roleCounts, toolCalls, markerHashes, userTexts };
  }

  // ── Semantic expectation validation ───────────────────────────────────────

  private validateExpectation(expectation: RequestExpectation, request: ReturnType<ScriptedProvider["normalize"]>): void {
    const messages = request.messages;
    if (expectation.candidate && request.model !== expectation.candidate) {
      throw new FixtureExpectationError(`candidate mismatch: expected ${expectation.candidate}, got ${request.model}`);
    }

    if (expectation.orderedContains) {
      let cursor = 0;
      for (const marker of expectation.orderedContains) {
        let found = false;
        while (cursor < messages.length) {
          const text = messages[cursor]!.text;
          if (text.includes(marker)) {
            found = true;
            cursor++;
            break;
          }
          cursor++;
        }
        if (!found) {
          throw new FixtureExpectationError(`ordered marker missing after index ${cursor - 1}: ${shortHash(marker)}`);
        }
      }
    }

    if (expectation.exactlyOnce) {
      for (const marker of expectation.exactlyOnce) {
        let count = 0;
        for (const m of messages) {
          if (m.text.includes(marker)) count++;
        }
        if (count !== 1) {
          throw new FixtureExpectationError(`marker ${shortHash(marker)} appears ${count} times (expected exactly once)`);
        }
      }
    }

    if (expectation.excludes) {
      for (const marker of expectation.excludes) {
        for (const m of messages) {
          if (m.text.includes(marker)) {
            throw new FixtureExpectationError(`excluded marker ${shortHash(marker)} appears in request`);
          }
        }
      }
    }

    if (expectation.currentTurn) {
      const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
      if (lastUserIndex < 0) {
        throw new FixtureExpectationError(`current-turn marker ${shortHash(expectation.currentTurn)} requires a user message`);
      }
      const lastText = messages[lastUserIndex]!.text;
      if (!lastText.includes(expectation.currentTurn)) {
        throw new FixtureExpectationError(`current turn does not contain its marker ${shortHash(expectation.currentTurn)}`);
      }
      for (let i = 0; i < lastUserIndex; i++) {
        if (messages[i]!.text.includes(expectation.currentTurn)) {
          throw new FixtureExpectationError(`current-turn marker ${shortHash(expectation.currentTurn)} appears BEFORE the current turn`);
        }
      }
      // The current marker may also appear exactly once overall.
      let count = 0;
      for (const m of messages) if (m.text.includes(expectation.currentTurn)) count++;
      if (count !== 1) {
        throw new FixtureExpectationError(`current-turn marker ${shortHash(expectation.currentTurn)} appears ${count} times (duplicate current turn)`);
      }
    }

    if (expectation.noToolBeforeCurrent) {
      const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
      for (let i = 0; i < lastUserIndex; i++) {
        const m = messages[i]!;
        if (m.role === "tool" || (m.toolCalls && m.toolCalls.length > 0)) {
          throw new FixtureExpectationError("tool call/result appears before the current-turn baseline");
        }
      }
    }
  }

  // ── SSE streaming ─────────────────────────────────────────────────────────

  private sseStart(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }

  private sseChunk(res: ServerResponse, model: string, delta: string): void {
    const payload = JSON.stringify({
      id: `chatcmpl-fixture-${this.seq}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }],
    });
    res.write(`data: ${payload}\n\n`);
  }

  private async streamText(res: ServerResponse, model: string, chunks: string[]): Promise<void> {
    this.sseStart(res);
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += CHUNK_MAX) {
        this.sseChunk(res, model, chunk.slice(i, i + CHUNK_MAX));
        await delay(2);
      }
    }
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-fixture-${this.seq}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private async streamToolCall(res: ServerResponse, name: string, args: unknown): Promise<void> {
    this.sseStart(res);
    const argsText = typeof args === "string" ? args : JSON.stringify(args);
    const toolPayload = JSON.stringify({
      id: `chatcmpl-fixture-${this.seq}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fixture",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: `call_fixture_${this.seq}`,
            type: "function",
            function: { name, arguments: argsText },
          }],
        },
        finish_reason: null,
      }],
    });
    res.write(`data: ${toolPayload}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-fixture-${this.seq}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function shortHash(marker: string): string {
  return createHash("sha256").update(marker).digest("hex").slice(0, 8);
}

function readBounded(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
