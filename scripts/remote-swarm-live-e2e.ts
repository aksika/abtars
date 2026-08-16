#!/usr/bin/env node
/**
 * remote-swarm-live-e2e.ts — #1624 live two-node swarm acceptance controller.
 *
 * Runs on the requester host. Executes requester commands locally and
 * receiver commands through the approved tmux-over-SSH channel. All mutation
 * goes through production CLI/API/peer paths; the controller itself never
 * writes to either node's database.
 *
 *   tsx scripts/remote-swarm-live-e2e.ts --profile foundation|full \
 *       --profile-file <private profile> --expected-commit <sha> \
 *       [--allow-restarts] [--allow-resume] [--run-id <id>]
 */

import { execFile } from "node:child_process";
import * as https from "node:https";
import * as net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTRACT_BOUNDS,
  REMOTE_SWARM_EVENT_MARKER,
  REMOTE_SWARM_DEV_TEST_PREFIX,
  REMOTE_SWARM_PROBE_RESULT_MARKER,
  REMOTE_SWARM_PROBE_EVENT_MARKER,
  isSafeArgvToken,
  isValidRunId,
  runMarker,
  validateLiveResult,
  validateNodeResult,
  validateProfile,
  type LiveNodeProfileV1,
  type RemoteSwarmCleanupResultV1,
  type RemoteSwarmEventRecordV1,
  type RemoteSwarmLiveProfileV1,
  type RemoteSwarmLiveResultV1,
  type RemoteSwarmNodeCommandV1,
  type RemoteSwarmNodeResultV1,
  type RemoteSwarmProfileName,
  type RemoteSwarmResumeApprovalV1,
  type RemoteSwarmRole,
  type RemoteSwarmScenarioResultV1,
  type RemoteSwarmSnapshotV1,
} from "./remote-swarm-live-contracts.ts";

const bounds = CONTRACT_BOUNDS;

// ── CLI parsing ──────────────────────────────────────────────────────────────

export interface ControllerArgs {
  profile: RemoteSwarmProfileName;
  profileFile: string;
  expectedCommit: string;
  allowRestarts: boolean;
  allowResume: boolean;
  runId?: string;
}

export function parseControllerArgs(argv: string[]): ControllerArgs {
  let profile: RemoteSwarmProfileName | undefined;
  let profileFile: string | undefined;
  let expectedCommit: string | undefined;
  let allowRestarts = false;
  let allowResume = false;
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (arg === "--profile") {
      if (next !== "foundation" && next !== "full") throw new Error(`--profile must be foundation or full (got ${JSON.stringify(next)})`);
      profile = next;
      i++;
    } else if (arg === "--profile-file") {
      if (!next || next.length === 0 || !next.startsWith("/")) throw new Error("--profile-file requires an absolute path");
      profileFile = next;
      i++;
    } else if (arg === "--expected-commit") {
      if (!next || !/^[0-9a-f]{4,64}$/i.test(next)) throw new Error("--expected-commit requires a git sha prefix");
      expectedCommit = next;
      i++;
    } else if (arg === "--allow-restarts") {
      allowRestarts = true;
    } else if (arg === "--allow-resume") {
      allowResume = true;
    } else if (arg === "--run-id") {
      if (!next || !isValidRunId(next)) throw new Error("--run-id must match [A-Za-z0-9._:-]{3,64}");
      runId = next;
      i++;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (profile === undefined) throw new Error("--profile foundation|full is required");
  if (profileFile === undefined) throw new Error("--profile-file is required");
  if (expectedCommit === undefined) throw new Error("--expected-commit is required");
  return { profile, profileFile, expectedCommit, allowRestarts, allowResume, runId };
}

export function buildRunId(now: Date): string {
  return `rs-live-${now.getTime()}-${randomUUID().slice(0, 6)}`;
}

// ── Command ports ────────────────────────────────────────────────────────────

export type CommandArg = { text: string; quote: boolean };

export interface PortResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandPort {
  run(argv: CommandArg[], opts: { timeoutMs: number; cwd?: string }): Promise<PortResult>;
}

export function quoteArg(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function validateArgs(argv: CommandArg[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.text.length === 0 || arg.text.length > bounds.argvToken * 8) {
      throw new Error(`command argument rejected: exceeds bounds`);
    }
    if (arg.quote) {
      out.push(arg.text);
    } else {
      if (!isSafeArgvToken(arg.text)) {
        throw new Error(`command argument rejected as unsafe: ${JSON.stringify(arg.text.slice(0, 80))} (len=${arg.text.length})`);
      }
      out.push(arg.text);
    }
  }
  return out;
}

/**
 * Build the tmux command-line tokens: bare safe tokens stay raw, quoted
 * tokens are wrapped in single-quote escaping. The result is one injection-
 * safe shell line.
 */
function buildTmuxTokens(argv: CommandArg[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.text.length === 0 || arg.text.length > bounds.argvToken * 8) {
      throw new Error(`command argument rejected: exceeds bounds`);
    }
    if (arg.quote) {
      out.push(quoteArg(arg.text));
    } else {
      if (!isSafeArgvToken(arg.text)) {
        throw new Error(`command argument rejected as unsafe: ${JSON.stringify(arg.text.slice(0, 80))} (len=${arg.text.length})`);
      }
      out.push(arg.text);
    }
  }
  return out;
}

const MAX_PORT_OUTPUT_BYTES = 256 * 1024;

function boundedAppend(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length > MAX_PORT_OUTPUT_BYTES ? next.slice(-MAX_PORT_OUTPUT_BYTES) : next;
}

/**
 * Local execFile-based port. Argument arrays only — never a shell string.
 */
export class LocalCommandPort implements CommandPort {
  async run(argv: CommandArg[], opts: { timeoutMs: number; cwd?: string }): Promise<PortResult> {
    const args = validateArgs(argv);
    const [command, ...rest] = args;
    if (!command) throw new Error("empty command");
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = execFile(command, rest, { cwd: opts.cwd, maxBuffer: MAX_PORT_OUTPUT_BYTES + 4096 }, (err) => {
        const exitCode = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ ok: !err || timedOut ? !err : false, exitCode, stdout, stderr, timedOut });
      });
      child.stdout?.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk.toString("utf-8")); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk.toString("utf-8")); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);
      child.on("close", () => clearTimeout(timer));
    });
  }
}

interface TmuxCommandPortOptions {
  session: string;
  pollMs?: number;
  tmuxBin?: string;
}

/**
 * tmux-over-SSH port. Sends ONE quoted command line to the configured
 * existing tmux session, then polls `capture-pane` for unique begin/end
 * markers. Never opens bare SSH, never kills the shared tmux session.
 * Cancellation sends C-c and captures the final bounded pane.
 */
export class TmuxCommandPort implements CommandPort {
  private readonly session: string;
  private readonly pollMs: number;
  private readonly tmuxBin: string;
  private inFlight = false;

  constructor(opts: TmuxCommandPortOptions) {
    this.session = opts.session;
    this.pollMs = opts.pollMs ?? 2500;
    this.tmuxBin = opts.tmuxBin ?? "tmux";
  }

  private async tmux(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(this.tmuxBin, args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: MAX_PORT_OUTPUT_BYTES + 4096 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sendKeys(text: string, timeoutMs: number): Promise<boolean> {
    const result = await this.tmux(["send-keys", "-t", this.session, text, "Enter"], timeoutMs);
    return result.ok;
  }

  private async capture(timeoutMs: number): Promise<string> {
    // -J rejoins pane rows that were wrapped at the terminal width, so long
    // single-line probe JSON survives capture intact.
    const result = await this.tmux(["capture-pane", "-t", this.session, "-p", "-J", "-S", "-2000"], timeoutMs);
    return result.ok ? result.output : "";
  }

  async run(argv: CommandArg[], opts: { timeoutMs: number; cwd?: string }): Promise<PortResult> {
    if (this.inFlight) {
      return { ok: false, exitCode: null, stdout: "", stderr: "another tmux command is still in flight", timedOut: false };
    }
    this.inFlight = true;
    try {
      return await this.execute(argv, opts);
    } finally {
      this.inFlight = false;
    }
  }

  private async execute(argv: CommandArg[], opts: { timeoutMs: number; cwd?: string }): Promise<PortResult> {
    const tokens = buildTmuxTokens(argv);
    const nonce = randomUUID().slice(0, 8);
    const begin = `RSM_BEGIN_${nonce}`;
    const end = `RSM_END_${nonce}`;
    const commandLine = [
      `echo ${begin}`,
      `cd ${quoteArg(opts.cwd ?? ".")}`,
      tokens.join(" "),
      `echo ${end}`,
    ].join(" ; ");

    const deadline = Date.now() + opts.timeoutMs;
    const sendResult = await this.sendKeys(commandLine, Math.max(5_000, Math.min(opts.timeoutMs, 30_000)));
    if (!sendResult) {
      return { ok: false, exitCode: null, stdout: "", stderr: `tmux send-keys failed for session ${this.session}`, timedOut: false };
    }

    let pane = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      pane = await this.capture(10_000);
      const beginIndex = pane.lastIndexOf(begin);
      if (beginIndex >= 0) {
        const afterBegin = pane.slice(beginIndex + begin.length);
        const endIndex = afterBegin.lastIndexOf(end);
        if (endIndex >= 0) {
          const body = afterBegin.slice(0, endIndex).trim();
          return { ok: true, exitCode: 0, stdout: body, stderr: "", timedOut: false };
        }
      }
    }

    await this.sendKeys("C-c", 10_000);
    await new Promise((r) => setTimeout(r, 1_000));
    const finalPane = await this.capture(10_000);
    const beginIndex = finalPane.lastIndexOf(begin);
    const tail = beginIndex >= 0 ? finalPane.slice(beginIndex + begin.length) : finalPane;
    return { ok: false, exitCode: null, stdout: tail.slice(-MAX_PORT_OUTPUT_BYTES), stderr: `tmux command timed out after ${opts.timeoutMs}ms`, timedOut: true };
  }
}

// ── Probe client ─────────────────────────────────────────────────────────────

export function parseProbeOutput(stdout: string): { result: unknown; events: unknown[] } {
  let result: unknown = null;
  const events: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(REMOTE_SWARM_PROBE_RESULT_MARKER)) {
      try {
        result = JSON.parse(line.slice(REMOTE_SWARM_PROBE_RESULT_MARKER.length));
      } catch { /* keep null */ }
    } else if (line.startsWith(REMOTE_SWARM_PROBE_EVENT_MARKER)) {
      try {
        events.push(JSON.parse(line.slice(REMOTE_SWARM_PROBE_EVENT_MARKER.length)));
      } catch { /* skip malformed event */ }
    }
  }
  return { result, events };
}

export class ProbeClient {
  constructor(
    private readonly profile: RemoteSwarmLiveProfileV1,
    private readonly requesterPort: CommandPort,
    private readonly receiverPort: CommandPort,
    private readonly onEvent: (record: RemoteSwarmEventRecordV1) => void,
    private readonly probeTimeoutMs: number,
  ) {}

  private nodeProfile(role: RemoteSwarmRole): LiveNodeProfileV1 {
    return role === "requester" ? this.profile.requester : this.profile.receiver;
  }

  portFor(role: RemoteSwarmRole): CommandPort {
    return role === "requester" ? this.requesterPort : this.receiverPort;
  }

  private nodeName(role: RemoteSwarmRole): string {
    return role === "requester" ? "requester" : "receiver";
  }

  async run(command: RemoteSwarmNodeCommandV1, timeoutMs?: number): Promise<RemoteSwarmNodeResultV1> {
    const role = command.role;
    const node = this.nodeProfile(role);
    const nodeName = this.nodeName(role);
    const payload = JSON.stringify(command);
    const encoded = Buffer.from(payload, "utf-8").toString("base64url");
    const argv: CommandArg[] = [
      { text: node.node ?? "node", quote: false },
      { text: "scripts/remote-swarm-live-node.ts", quote: false },
      { text: "--home", quote: false },
      { text: node.abtarsHome, quote: false },
      { text: "--role", quote: false },
      { text: role, quote: false },
      { text: "--run-id", quote: false },
      { text: command.runId, quote: false },
      { text: "--command", quote: false },
      { text: command.command, quote: false },
      { text: "--json", quote: false },
      { text: encoded, quote: false },
    ];
    if (command.expectedCommit !== undefined) {
      argv.push({ text: "--expected-commit", quote: false }, { text: command.expectedCommit, quote: false });
    }
    if (command.requirePiAlias !== undefined) {
      argv.push({ text: "--require-pi-alias", quote: false }, { text: command.requirePiAlias, quote: false });
    }
    if (command.marker !== undefined) {
      argv.push({ text: "--marker", quote: false }, { text: command.marker, quote: true });
    }
    if (command.peer !== undefined) {
      argv.push({ text: "--peer", quote: false }, { text: command.peer, quote: false });
    }
    if (command.lines !== undefined) {
      argv.push({ text: "--lines", quote: false }, { text: String(command.lines), quote: false });
    }

    this.onEvent({ ts: new Date().toISOString(), stage: `probe:${command.command}`, node: role, message: `${nodeName} ${command.command}` });
    const result = await this.portFor(role).run(argv, { timeoutMs: timeoutMs ?? this.probeTimeoutMs, cwd: node.workdir });
    if (!result.ok) {
      throw new ProbeCommandError(command.command, role, result);
    }
    const { result: parsed } = parseProbeOutput(result.stdout);
    if (parsed === null) {
      throw new Error(`probe on ${nodeName} produced no ${REMOTE_SWARM_PROBE_RESULT_MARKER} line`);
    }
    const validation = validateNodeResult(parsed, role, command.runId);
    if (!validation.ok) {
      throw new Error(`probe on ${nodeName} returned an invalid result: ${validation.error}`);
    }
    return validation.value;
  }
}

export class ProbeCommandError extends Error {
  constructor(
    readonly command: string,
    readonly role: RemoteSwarmRole,
    readonly portResult: PortResult,
  ) {
    super(`probe command ${command} on ${role} failed (exit=${portResult.exitCode ?? "?"}, timedOut=${portResult.timedOut}): ${portResult.stderr.slice(0, 500)}`);
  }
}

// ── Delegate route client (production loopback path) ─────────────────────────

export interface DelegateBody {
  peer: string;
  goal: string;
  title?: string;
  request_id?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export interface DelegateResponse {
  ok: boolean;
  decision: string;
  projectCardId?: number;
  proxyCardId?: number;
  requestId?: string;
  contributionRef?: string;
  reasonCode?: string;
  reason?: string;
  error?: string;
}

export type HttpDelegatePort = (body: DelegateBody, node: "requester" | "receiver") => Promise<DelegateResponse>;

function httpsPostJson(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 256_000) res.destroy();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export function createHttpDelegatePort(profile: RemoteSwarmLiveProfileV1, receiverPort?: CommandPort): HttpDelegatePort {
  return async (body, node) => {
    if (node === "requester") {
      const port = profile.requester.agentApiPort;
      if (!port) throw new Error("agentApiPort is not configured for requester");
      const response = await httpsPostJson(port, "/v1/orc/delegate", body);
      return parseDelegateResponse(response.status, response.body);
    }
    // The receiver's delegate route is loopback-only, so the request must
    // originate on the receiver host through the approved tmux channel. The
    // abtars agent API uses a self-signed Ed25519 identity cert; node's
    // https.request honors rejectUnauthorized:false where curl and undici
    // fetch fail on the receiver host.
    const port = profile.receiver.agentApiPort;
    if (!port) throw new Error("agentApiPort is not configured for receiver");
    if (!receiverPort) throw new Error("receiver command port is required for receiver-side delegation");
    const receiver = profile.receiver;
    const payload = JSON.stringify(body);
    const script = [
      "const https=require(\"node:https\");",
      "const body=process.argv[2];",
      `const req=https.request({host:"127.0.0.1",port:${port},path:"/v1/orc/delegate",method:"POST",rejectUnauthorized:false,headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{let d=\"\";res.on(\"data\",c=>d+=c);res.on(\"end\",()=>console.log(\"REMOTE_SWARM_DELEGATE=\"+d))});`,
      "req.on(\"error\",e=>{console.error(\"REMOTE_SWARM_DELEGATE_ERROR=\"+e.message);process.exit(1)});",
      "req.end(body)",
    ].join("");
    const result = await receiverPort.run([
      { text: "node", quote: false },
      { text: "-e", quote: false },
      { text: script, quote: true },
      { text: payload, quote: true },
    ], { timeoutMs: 120_000, cwd: receiver.workdir });
    if (!result.ok) {
      return { ok: false, decision: "error", error: `receiver delegate failed: ${result.stderr.slice(0, 500)}` };
    }
    const marker = "REMOTE_SWARM_DELEGATE=";
    const line = result.stdout.split("\n").find((l) => l.startsWith(marker));
    if (!line) {
      return { ok: false, decision: "error", error: `receiver delegate produced no response: ${result.stdout.slice(0, 300)}` };
    }
    return parseDelegateResponse(200, line.slice(marker.length));
  };
}

function parseDelegateResponse(status: number, rawBody: string): DelegateResponse {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, decision: "error", error: `delegate route returned non-JSON (HTTP ${status}): ${rawBody.slice(0, 300)}` };
  }
  const decision = typeof parsed.decision === "string" ? parsed.decision : "error";
  return {
    ok: parsed.ok === true,
    decision,
    projectCardId: typeof parsed.project_card_id === "number" ? parsed.project_card_id : undefined,
    proxyCardId: typeof parsed.proxy_card_id === "number" ? parsed.proxy_card_id : undefined,
    requestId: typeof parsed.request_id === "string" ? parsed.request_id : undefined,
    contributionRef: typeof parsed.contribution_ref === "string" ? parsed.contribution_ref : undefined,
    reasonCode: typeof parsed.reason_code === "string" ? parsed.reason_code : undefined,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

// ── TUI Orc client (production live-call surface) ────────────────────────────

export interface OrcCallResult {
  reply: string;
  sessionId: string | null;
}

export interface OrcCallPort {
  call(goal: string, opts: { timeoutMs: number }): Promise<OrcCallResult>;
}

export interface TuiSocketOptions {
  socketPath: string;
}

interface TuiServerFrame {
  t: string;
  [key: string]: unknown;
}

export class TuiOrcClient implements OrcCallPort {
  private readonly socketPath: string;

  constructor(opts: TuiSocketOptions) {
    this.socketPath = opts.socketPath;
  }

  async connect(mode: "new" | "resume" = "new"): Promise<{ socket: net.Socket; sessionId: string | null; close: () => void }> {
    const socket = net.createConnection(this.socketPath);
    let sessionId: string | null = null;
    await new Promise<void>((resolve, reject) => {
      socket.once("error", (err) => reject(err));
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        socket.write(JSON.stringify({ t: "attach", mode: mode === "new" ? { kind: "new", sessionType: "A" } : { kind: "resume" }, cols: 100, rows: 30 }) + "\n");
        resolve();
      });
    });
    const frames = await this.awaitReady(socket, 30_000);
    if (frames === null) throw new Error("TUI attach rejected or timed out");
    for (const frame of frames) {
      if (frame.t === "ready" && typeof frame.sessionId === "string") sessionId = frame.sessionId;
    }
    return {
      socket,
      sessionId,
      close: () => { try { socket.destroy(); } catch { /* already closed */ } },
    };
  }

  private awaitReady(socket: net.Socket, timeoutMs: number): Promise<TuiServerFrame[] | null> {
    return new Promise((resolve) => {
      const frames: TuiServerFrame[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (line.trim() === "") continue;
          try {
            const frame = JSON.parse(line) as TuiServerFrame;
            frames.push(frame);
            if (frame.t === "ready" || frame.t === "error") {
              settled = true;
              clearTimeout(timer);
              socket.removeListener("data", onData);
              resolve(frames);
              return;
            }
          } catch { /* skip partial line */ }
        }
      };
      socket.on("data", onData);
    });
  }

  async call(goal: string, opts: { timeoutMs: number }): Promise<OrcCallResult> {
    const conn = await this.connect("new");
    try {
      conn.socket.write(JSON.stringify({ t: "input", text: goal }) + "\n");
      const frames = await this.awaitReply(conn.socket, opts.timeoutMs);
      const markdown = frames
        .filter((f) => f.t === "message" && typeof f.markdown === "string")
        .map((f) => String(f.markdown))
        .join("\n")
        .slice(0, 16_384);
      for (const frame of frames) {
        if (frame.t === "error") {
          throw new Error(`TUI error frame: ${String(frame.message ?? "unknown")}`);
        }
      }
      return { reply: markdown, sessionId: conn.sessionId };
    } finally {
      conn.close();
    }
  }

  private awaitReply(socket: net.Socket, timeoutMs: number): Promise<TuiServerFrame[]> {
    return new Promise((resolve) => {
      const frames: TuiServerFrame[] = [];
      let settled = false;
      let streamText = "";
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(frames); }
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (line.trim() === "") continue;
          let frame: TuiServerFrame;
          try {
            frame = JSON.parse(line) as TuiServerFrame;
          } catch { continue; }
          frames.push(frame);
          if (frame.t === "message" && typeof frame.markdown === "string") {
            const text = String(frame.markdown);
            if (!text.trimStart().startsWith("🔧 ") && text.trim().length > 0) {
              settled = true;
              clearTimeout(timer);
              socket.removeListener("data", onData);
              resolve(frames);
              return;
            }
          } else if (frame.t === "chunk" && typeof frame.delta === "string") {
            streamText += String(frame.delta);
          } else if (frame.t === "chunk-end") {
            if (frame.reason === "error") {
              settled = true;
              clearTimeout(timer);
              socket.removeListener("data", onData);
              resolve(frames);
              return;
            }
            if (frame.reason === "complete" && streamText.trim().length > 0) {
              settled = true;
              clearTimeout(timer);
              socket.removeListener("data", onData);
              resolve(frames);
              return;
            }
          } else if (frame.t === "error") {
            settled = true;
            clearTimeout(timer);
            socket.removeListener("data", onData);
            resolve(frames);
            return;
          }
        }
      };
      socket.on("data", onData);
    });
  }
}

// ── Polling helpers ──────────────────────────────────────────────────────────

export async function pollUntil<T>(
  label: string,
  read: () => Promise<T | null | undefined>,
  timeoutMs: number,
  opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await sleep(interval);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`);
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

function contributionFor(snap: RemoteSwarmSnapshotV1, requestId: string): RemoteSwarmSnapshotV1["contributions"][number] | undefined {
  return snap.contributions.find((c) => c.requestId === requestId);
}

function eventFor(snap: RemoteSwarmSnapshotV1, requestId: string, kind?: string): RemoteSwarmSnapshotV1["contributionEvents"][number] | undefined {
  const events = snap.contributionEvents.filter((e) => e.requestId === requestId);
  return kind === undefined ? events[0] : events.find((e) => e.kind === kind);
}

function cardsForSourceId(snap: RemoteSwarmSnapshotV1, sourceId: string): RemoteSwarmSnapshotV1["cards"] {
  return snap.cards.filter((c) => c.sourceId === sourceId);
}

function cardById(snap: RemoteSwarmSnapshotV1, cardId: number): RemoteSwarmSnapshotV1["cards"][number] | undefined {
  return snap.cards.find((c) => c.id === cardId);
}

function supervisionForCard(snap: RemoteSwarmSnapshotV1, cardId: number): RemoteSwarmSnapshotV1["supervisions"][number] | undefined {
  return snap.supervisions.find((s) => s.projectCardId === cardId);
}

function helpRequestFor(snap: RemoteSwarmSnapshotV1, requestId: string): RemoteSwarmSnapshotV1["helpRequests"][number] | undefined {
  return snap.helpRequests.find((h) => h.requestId === requestId);
}

function outboxForCard(snap: RemoteSwarmSnapshotV1, cardId: number): RemoteSwarmSnapshotV1["acceptanceOutbox"][number] | undefined {
  return snap.acceptanceOutbox.find((o) => o.projectCardId === cardId);
}

function reviewCasesForCard(snap: RemoteSwarmSnapshotV1, cardId: number): RemoteSwarmSnapshotV1["reviewCases"] {
  return snap.reviewCases.filter((c) => c.projectCardId === cardId);
}

function reviewDecisionsForCard(snap: RemoteSwarmSnapshotV1, cardId: number): RemoteSwarmSnapshotV1["reviewDecisions"] {
  return snap.reviewDecisions.filter((d) => d.projectCardId === cardId);
}

function piRunFor(snap: RemoteSwarmSnapshotV1, runId: string): RemoteSwarmSnapshotV1["piRuns"][number] | undefined {
  return snap.piRuns.find((r) => r.runId === runId);
}

function originProjectionFor(snap: RemoteSwarmSnapshotV1, runId: string): RemoteSwarmSnapshotV1["piOriginProjections"][number] | undefined {
  return snap.piOriginProjections.find((p) => p.runId === runId);
}

// ── Evidence writer ──────────────────────────────────────────────────────────

export class EvidenceWriter {
  readonly root: string;

  constructor(evidenceRoot: string, runId: string) {
    this.root = join(evidenceRoot, runId);
    mkdirSync(this.root, { recursive: true });
  }

  atomicWrite(name: string, content: string): void {
    const target = join(this.root, name);
    const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  }

  writeResult(result: RemoteSwarmLiveResultV1): void {
    this.atomicWrite("result.json", JSON.stringify(result, null, 2) + "\n");
  }

  writeJunit(result: RemoteSwarmLiveResultV1): void {
    const cases = result.scenarios.map((s) => {
      const body = s.failure
        ? `<failure message="${escapeXml(s.failure.message)}">${escapeXml(`[${s.failure.stage}/${s.failure.code}] ${s.failure.message}`)}</failure>`
        : "";
      return `<testcase classname="remote-swarm-live-e2e.${result.profile}" name="${escapeXml(s.id)}" time="${(s.durationMs / 1000).toFixed(3)}">${body}</testcase>`;
    }).join("\n");
    const cleanupCase = `<testcase classname="remote-swarm-live-e2e.${result.profile}" name="cleanup" time="0.000">${result.cleanup.state === "passed" ? "" : `<failure message="cleanup ${result.cleanup.state}">${escapeXml(result.cleanup.assertions.filter((a) => !a.passed).map((a) => a.id).join(", "))}</failure>`}</testcase>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="remote-swarm-live-e2e" tests="${result.scenarios.length + 1}" failures="${result.scenarios.filter((s) => s.state === "failed").length + (result.cleanup.state === "passed" ? 0 : 1)}">\n${cases}\n${cleanupCase}\n</testsuite>\n`;
    this.atomicWrite("junit.xml", xml);
  }

  appendEvent(record: RemoteSwarmEventRecordV1): void {
    try {
      const file = join(this.root, "events.jsonl");
      const line = `${REMOTE_SWARM_EVENT_MARKER}${JSON.stringify(record)}\n`;
      appendFileSync(file, line);
    } catch { /* evidence failure is surfaced by the caller */ }
  }

  writeFailureTail(name: string, tail: string): void {
    this.atomicWrite(name, tail);
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Scenario runner ──────────────────────────────────────────────────────────

export interface ScenarioContext {
  runId: string;
  marker: string;
  profile: RemoteSwarmLiveProfileV1;
  expectedCommit: string;
  allowRestarts: boolean;
  allowResume: boolean;
  probes: ProbeClient;
  delegate: HttpDelegatePort;
  orcCall: OrcCallPort | null;
  onEvent: (record: RemoteSwarmEventRecordV1) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  tracked: TrackedObjects;
}

export interface TrackedObjects {
  requestIds: string[];
  contributionRefs: string[];
  requesterRootCards: number[];
  requesterProxyCards: number[];
  receiverCards: number[];
  piRunIds: string[];
}

export function newTrackedObjects(): TrackedObjects {
  return { requestIds: [], contributionRefs: [], requesterRootCards: [], requesterProxyCards: [], receiverCards: [], piRunIds: [] };
}

export async function runScenario(
  ctx: ScenarioContext,
  id: string,
  name: string,
  fn: (s: RemoteSwarmScenarioResultV1) => Promise<void>,
  timeoutMs: number,
): Promise<RemoteSwarmScenarioResultV1> {
  const scenario: RemoteSwarmScenarioResultV1 = {
    id,
    name,
    state: "passed",
    startedAt: ctx.now().toISOString(),
    finishedAt: "",
    durationMs: 0,
    failure: null,
    evidence: [],
  };
  const start = Date.now();
  try {
    await Promise.race([
      fn(scenario),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`scenario ${id} exceeded ${timeoutMs}ms deadline`)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    // A scenario body may mark itself blocked; everything else that resolves
    // without an error is passed.
    if (scenario.state !== "blocked") scenario.state = "passed";
  } catch (err) {
    scenario.state = "failed";
    scenario.failure = {
      stage: id,
      code: "SCENARIO_FAILED",
      message: (err instanceof Error ? err.message : String(err)).slice(0, bounds.message),
    };
  }
  scenario.finishedAt = ctx.now().toISOString();
  scenario.durationMs = Date.now() - start;
  return scenario;
}

async function snapshotBoth(ctx: ScenarioContext, requestIds: string[], marker: string): Promise<{ requester: RemoteSwarmSnapshotV1; receiver: RemoteSwarmSnapshotV1 }> {
  const requesterResult = await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "snapshot", requestIds, marker });
  const receiverResult = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "snapshot", requestIds, marker });
  if (requesterResult.kind !== "snapshot" || receiverResult.kind !== "snapshot") throw new Error("snapshot probes returned unexpected kinds");
  return { requester: requesterResult.value, receiver: receiverResult.value };
}

async function pollSnapshot(
  ctx: ScenarioContext,
  role: RemoteSwarmRole,
  requestIds: string[],
  marker: string,
  predicate: (snap: RemoteSwarmSnapshotV1) => unknown,
  timeoutMs: number,
): Promise<RemoteSwarmSnapshotV1> {
  return pollUntil(`snapshot:${role}`, async () => {
    const result = await ctx.probes.run({ version: 1, role, runId: ctx.runId, command: "snapshot", requestIds, marker });
    if (result.kind !== "snapshot") throw new Error(`probe on ${role} returned ${result.kind}, expected snapshot`);
    const snap = result.value;
    return predicate(snap) ? snap : null;
  }, timeoutMs, { intervalMs: 2_000, sleep: ctx.sleep });
}

// ── Foundation profile ───────────────────────────────────────────────────────



export async function runFoundation(ctx: ScenarioContext): Promise<RemoteSwarmScenarioResultV1[]> {
  const scenarios: RemoteSwarmScenarioResultV1[] = [];
  const baseRequestId = `swarm-${ctx.runId}-f1`;

  scenarios.push(await runScenario(ctx, "accepted-journey", "accepted contribution journey", async (scenario) => {
    const requestId = `${baseRequestId}-accepted`;
    ctx.tracked.requestIds.push(requestId);
    const goal = `${runMarker(ctx.runId)} Reply with exactly the single word: ok. Do nothing else.`;
    const delegateResult = await ctx.delegate(
      { peer: ctx.profile.receiverPeerName, goal, request_id: requestId, priority: "MEDIUM" },
      "requester",
    );
    if (!delegateResult.ok) throw new Error(`delegate route failed: ${delegateResult.error ?? "unknown"}`);
    if (delegateResult.decision !== "accepted") {
      throw new Error(`expected accepted admission, got ${delegateResult.decision} (${delegateResult.reasonCode ?? ""})`);
    }
    if (!delegateResult.contributionRef) throw new Error("delegate response missing contribution_ref");
    if (!delegateResult.projectCardId || !delegateResult.proxyCardId) throw new Error("delegate response missing project/proxy card ids");
    ctx.tracked.contributionRefs.push(delegateResult.contributionRef);
    ctx.tracked.requesterRootCards.push(delegateResult.projectCardId);
    ctx.tracked.requesterProxyCards.push(delegateResult.proxyCardId);
    scenario.evidence.push({ kind: "request", id: requestId }, { kind: "card", id: String(delegateResult.projectCardId) }, { kind: "card", id: String(delegateResult.proxyCardId) }, { kind: "contribution", id: delegateResult.contributionRef });

    const receiver = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const help = helpRequestFor(snap, requestId);
      if (!help || help.state !== "accepted" || help.localCardId === null) return null;
      const sup = supervisionForCard(snap, help.localCardId);
      const outbox = outboxForCard(snap, help.localCardId);
      const card = cardById(snap, help.localCardId);
      if (sup?.state !== "accepted" || !sup.acceptedDecisionId) return null;
      if (!outbox || outbox.sentAt === null) return null;
      if (card?.status !== "delivered") return null;
      return snap;
    }, 10 * 60_000);

    const help = helpRequestFor(receiver, requestId);
    if (!help) throw new Error("receiver help request vanished");
    ctx.tracked.receiverCards.push(help.localCardId ?? 0);

    const requester = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
      const contribution = contributionFor(snap, requestId);
      if (!contribution || contribution.state !== "completed" || !contribution.terminalEventId) return null;
      const proxy = cardsForSourceId(snap, requestId).find((c) => c.type === "contribution");
      const root = cardsForSourceId(snap, requestId).find((c) => c.type === "O" && c.parentId === null);
      const rootSup = root ? supervisionForCard(snap, root.id) : undefined;
      if (proxy?.status !== "delivered") return null;
      if (root?.status !== "delivered" || rootSup?.state !== "accepted") return null;
      return snap;
    }, 10 * 60_000);

    const contribution = contributionFor(requester, requestId);
    if (!contribution) throw new Error("requester contribution vanished");
    const terminalEvent = eventFor(requester, requestId);
    if (!terminalEvent || terminalEvent.kind !== "completed") throw new Error("requester terminal event missing or not completed");
    if (contribution.terminalEventId !== terminalEvent.eventId) throw new Error("ledger terminal event id does not match the event row");

    const settledProxy = cardsForSourceId(requester, requestId).find((c) => c.type === "contribution");
    if (settledProxy?.notesRemoteRunId && !ctx.tracked.piRunIds.includes(settledProxy.notesRemoteRunId)) {
      ctx.tracked.piRunIds.push(settledProxy.notesRemoteRunId);
    }

    const proxyCards = cardsForSourceId(requester, requestId).filter((c) => c.type === "contribution");
    const rootCards = cardsForSourceId(requester, requestId).filter((c) => c.type === "O" && c.parentId === null);
    const receiverCards = cardsForSourceId(receiver, requestId).filter((c) => c.type === "O");
    const helpRows = receiver.helpRequests.filter((h) => h.requestId === requestId);
    const reviewCases = reviewCasesForCard(receiver, help.localCardId ?? 0);
    const reviewDecisions = reviewDecisionsForCard(receiver, help.localCardId ?? 0);
    const outboxRows = receiver.acceptanceOutbox.filter((o) => o.projectCardId === (help.localCardId ?? 0));

    if (proxyCards.length !== 1) throw new Error(`requester proxy cards for ${requestId}: ${proxyCards.length} (expected 1)`);
    if (rootCards.length !== 1) throw new Error(`requester root cards for ${requestId}: ${rootCards.length} (expected 1)`);
    if (receiverCards.length !== 1) throw new Error(`receiver O cards for ${requestId}: ${receiverCards.length} (expected 1)`);
    if (helpRows.length !== 1) throw new Error(`receiver help request rows for ${requestId}: ${helpRows.length} (expected 1)`);
    if (requester.contributions.filter((c) => c.requestId === requestId).length !== 1) throw new Error("requester ledger must hold exactly one row");
    if (requester.contributionEvents.filter((e) => e.requestId === requestId).length !== 1) throw new Error("requester event ledger must hold exactly one terminal event");
    if (reviewCases.filter((c) => c.status === "accepted").length !== 1) throw new Error("receiver review must hold exactly one accepted case");
    if (reviewDecisions.length !== 1) throw new Error("receiver review must hold exactly one decision");
    if (outboxRows.length !== 1) throw new Error("receiver outbox must hold exactly one row");

    const requestHashMismatch = contribution.requestHash !== help.requestHash;
    if (requestHashMismatch) throw new Error("requester and receiver request hashes disagree");
    if (!contribution.projection || contribution.projection.outcome !== "completed") throw new Error("requester projection outcome is not completed");
    if (!help.provesNonCreation && help.responseDecision !== "accepted") throw new Error("receiver admission response is not accepted");
    if (terminalEvent.payloadDigest === "" || terminalEvent.sequence < 0) throw new Error("terminal event is missing digest or sequence");

    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "accepted-journey", node: "controller", message: `accepted journey settled: request=${requestId} ref=${contribution.contributionRef} event=${terminalEvent.eventId}` });
    scenario.evidence.push({ kind: "event", id: terminalEvent.eventId });
  }, 20 * 60_000));

  scenarios.push(await runScenario(ctx, "replay-idempotent", "replay of a settled request id", async (scenario) => {
    const requestId = `${baseRequestId}-accepted`;
    const goal = `${runMarker(ctx.runId)} Reply with exactly the single word: ok. Do nothing else.`;
    const beforeRequester = await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker });
    const beforeReceiver = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker });
    if (beforeRequester.kind !== "snapshot" || beforeReceiver.kind !== "snapshot") throw new Error("snapshot probes returned unexpected kinds");

    const delegateResult = await ctx.delegate(
      { peer: ctx.profile.receiverPeerName, goal, request_id: requestId, priority: "MEDIUM" },
      "requester",
    );
    if (!delegateResult.ok) throw new Error(`replay delegate failed: ${delegateResult.error ?? "unknown"}`);
    if (!ctx.tracked.contributionRefs.includes(delegateResult.contributionRef ?? "")) {
      throw new Error("replay returned a different contribution reference");
    }
    if (!ctx.tracked.requesterRootCards.includes(delegateResult.projectCardId ?? -1)) {
      throw new Error("replay returned a different requester root card");
    }
    if (!ctx.tracked.requesterProxyCards.includes(delegateResult.proxyCardId ?? -1)) {
      throw new Error("replay returned a different requester proxy card");
    }

    const afterRequester = await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker });
    const afterReceiver = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker });
    if (afterRequester.kind !== "snapshot" || afterReceiver.kind !== "snapshot") throw new Error("snapshot probes returned unexpected kinds");

    const rq = afterRequester.value;
    const rv = afterReceiver.value;
    if (rq.contributionEvents.length !== beforeRequester.value.contributionEvents.length) throw new Error("replay created a second requester event");
    if (rq.contributions.length !== beforeRequester.value.contributions.length) throw new Error("replay created a second requester ledger row");
    if (rv.helpRequests.length !== beforeReceiver.value.helpRequests.length) throw new Error("replay created a second receiver reservation");
    if (cardsForSourceId(rv, requestId).length !== cardsForSourceId(beforeReceiver.value, requestId).length) throw new Error("replay created a second receiver card");
    if (rv.reviewDecisions.length !== beforeReceiver.value.reviewDecisions.length) throw new Error("replay created a second review decision");
    if (rv.acceptanceOutbox.length !== beforeReceiver.value.acceptanceOutbox.length) throw new Error("replay created a second outbox row");

    scenario.evidence.push({ kind: "request", id: requestId });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "replay-idempotent", node: "controller", message: "replay stable: no duplicate identities, events, or deliveries" });
  }, 5 * 60_000));

  scenarios.push(await runScenario(ctx, "declined-admission", "declined receiver admission", async (scenario) => {
    if (ctx.orcCall === null) {
      scenario.state = "blocked";
      scenario.failure = { stage: "declined-admission", code: "NO_ORC_SURFACE", message: "no requester TUI/chat surface configured; declined admission is Orc-driven" };
      return;
    }
    const requestId = `${baseRequestId}-declined`;
    ctx.tracked.requestIds.push(requestId);
    const missingCapability = `swarm-e2e-missing-${ctx.runId.slice(-16)}`;
    const goal = `${REMOTE_SWARM_DEV_TEST_PREFIX} ${runMarker(ctx.runId)} Use the peer_ask_help tool exactly once with peer "${ctx.profile.receiverPeerName}", request_id "${requestId}", goal "do not do anything, just decline", and requires ["${missingCapability}"]. Report the tool's result verbatim and do nothing else.`;
    const reply = await ctx.orcCall.call(goal, { timeoutMs: 8 * 60_000 });
    scenario.evidence.push({ kind: "chat", id: reply.sessionId ?? "tui" });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "declined-admission", node: "requester", message: `orc replied (${reply.reply.length} chars)` });

    // The requester's peer_ask_help inventory guard refuses to SEND a request
    // whose required capability the receiver's static inventory lacks, so a
    // receiver-side policy decline can never be produced through the
    // requester's production path. Record the finding as blocked evidence
    // rather than waiting out a doomed poll.
    if (reply.reply.includes("does not have the required capabilities")) {
      scenario.state = "blocked";
      scenario.failure = {
        stage: "declined-admission",
        code: "RECEIVER_DECLINE_UNREACHABLE",
        message: "requester inventory guard rejects the required capability before the request reaches the receiver; no deterministic receiver-decline path exists in the product (product defect filed separately)",
      };
      return;
    }

    const requester = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
      const contribution = contributionFor(snap, requestId);
      const proxy = cardsForSourceId(snap, requestId).find((c) => c.type === "contribution");
      if (contribution?.state === "declined" || proxy?.notesOutcome === "declined") return snap;
      return null;
    }, 6 * 60_000);
    const contribution = contributionFor(requester, requestId);
    if (!contribution || contribution.state !== "declined") {
      throw new Error(`requester contribution for ${requestId} did not settle declined (state=${contribution?.state ?? "missing"})`);
    }

    const receiver = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker });
    if (receiver.kind !== "snapshot") throw new Error("receiver snapshot probe returned unexpected kind");
    const help = helpRequestFor(receiver.value, requestId);
    if (help && help.localCardId !== null) throw new Error("declined admission still created a receiver card");
    if (help && help.provesNonCreation !== true && help.responseDecision !== "declined") {
      throw new Error(`declined admission lacks proves_non_creation (decision=${help.responseDecision})`);
    }
    const receiverCards = cardsForSourceId(receiver.value, requestId);
    if (receiverCards.length !== 0) throw new Error(`declined admission created ${receiverCards.length} receiver cards (expected 0)`);

    scenario.evidence.push({ kind: "request", id: requestId });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "declined-admission", node: "controller", message: `declined admission settled with proves_non_creation` });
  }, 15 * 60_000));

  scenarios.push(await runScenario(ctx, "no-relay-rejection", "peer-originated no-relay rejection", async (scenario) => {
    if (ctx.orcCall === null) {
      scenario.state = "blocked";
      scenario.failure = { stage: "no-relay-rejection", code: "NO_ORC_SURFACE", message: "no requester TUI/chat surface configured; no-relay is Orc-driven" };
      return;
    }
    const inboundRequestId = `${baseRequestId}-norelay-inbound`;
    const inboundGoal = `${runMarker(ctx.runId)} Reply with exactly the single word: ok. Do nothing else.`;
    const inbound = await ctx.delegate(
      { peer: ctx.profile.receiverPeerName, goal: inboundGoal, request_id: inboundRequestId, priority: "MEDIUM" },
      "receiver",
    );
    if (!inbound.ok || inbound.decision !== "accepted") {
      throw new Error(`reverse delegation was not accepted (${inbound.decision} ${inbound.reasonCode ?? ""})`);
    }
    ctx.tracked.requestIds.push(inboundRequestId);

    await pollSnapshot(ctx, "requester", [inboundRequestId], ctx.marker, (snap) => {
      const help = helpRequestFor(snap, inboundRequestId);
      if (!help || help.state !== "accepted" || help.localCardId === null) return null;
      const card = cardById(snap, help.localCardId);
      if (!card || card.type !== "O") return null;
      return snap;
    }, 5 * 60_000);

    const goal = `${REMOTE_SWARM_DEV_TEST_PREFIX} ${runMarker(ctx.runId)} You are working on a contribution that arrived from the peer "${ctx.profile.receiverPeerName}". Do not complete it locally. Instead call the peer_ask_help tool to ask a peer for help with it. Report the tool result verbatim. If the tool refuses, quote the refusal exactly.`;
    const reply = await ctx.orcCall.call(goal, { timeoutMs: 8 * 60_000 });
    scenario.evidence.push({ kind: "chat", id: reply.sessionId ?? "tui" });
    if (!reply.reply.includes("peer_relay_blocked")) {
      throw new Error(`requester Orc did not produce a peer_relay_blocked refusal; bounded reply: ${reply.reply.slice(0, 1_000)}`);
    }
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "no-relay-rejection", node: "requester", message: "peer_relay_blocked observed in requester reply" });
  }, 15 * 60_000));

  return scenarios;
}

// ── Full profile ─────────────────────────────────────────────────────────────



export async function runFull(ctx: ScenarioContext): Promise<RemoteSwarmScenarioResultV1[]> {
  const scenarios: RemoteSwarmScenarioResultV1[] = [];

  if (!ctx.allowRestarts) {
    scenarios.push({
      id: "recovery-restarts",
      name: "requester/receiver recovery restarts",
      state: "blocked",
      startedAt: ctx.now().toISOString(),
      finishedAt: ctx.now().toISOString(),
      durationMs: 0,
      failure: { stage: "recovery-restarts", code: "RESTARTS_NOT_ALLOWED", message: "--allow-restarts is required for the full profile" },
      evidence: [],
    });
  } else {
    scenarios.push(await runScenario(ctx, "recovery-restarts", "requester/receiver recovery restarts", async (scenario) => {
      const requestId = `swarm-${ctx.runId}-recovery`;
      ctx.tracked.requestIds.push(requestId);
      const goal = `${runMarker(ctx.runId)} Reply with exactly the single word: ok. Do nothing else.`;
      const delegateResult = await ctx.delegate(
        { peer: ctx.profile.receiverPeerName, goal, request_id: requestId, priority: "MEDIUM" },
        "requester",
      );
      if (!delegateResult.ok || delegateResult.decision !== "accepted") {
        throw new Error(`recovery delegation failed (${delegateResult.decision} ${delegateResult.reasonCode ?? ""})`);
      }
      ctx.tracked.requesterProxyCards.push(delegateResult.proxyCardId ?? 0);
      ctx.tracked.requesterRootCards.push(delegateResult.projectCardId ?? 0);

      const receiver = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
        const help = helpRequestFor(snap, requestId);
        if (!help || help.state !== "accepted" || help.localCardId === null) return null;
        return snap;
      }, 5 * 60_000);
      const help = helpRequestFor(receiver, requestId);
      ctx.tracked.receiverCards.push(help?.localCardId ?? 0);
      ctx.onEvent({ ts: ctx.now().toISOString(), stage: "recovery-restarts", node: "controller", message: "receiver owns the run; stopping requester" });

      await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "preflight", peer: ctx.profile.receiverPeerName }, 60_000);
      await stopRequester(ctx);

      await restartReceiver(ctx);
      ctx.onEvent({ ts: ctx.now().toISOString(), stage: "recovery-restarts", node: "controller", message: "receiver restarted; starting requester" });

      await startRequester(ctx);
      const requester = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
        const contribution = contributionFor(snap, requestId);
        const proxy = cardsForSourceId(snap, requestId).find((c) => c.type === "contribution");
        const root = cardsForSourceId(snap, requestId).find((c) => c.type === "O" && c.parentId === null);
        if (contribution?.state !== "completed" || !contribution.terminalEventId) return null;
        if (proxy?.status !== "delivered") return null;
        if (root?.status !== "delivered") return null;
        return snap;
      }, 10 * 60_000);

      const finalReceiver = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
        const helpRow = helpRequestFor(snap, requestId);
        if (!helpRow || helpRow.localCardId === null) return null;
        const sup = supervisionForCard(snap, helpRow.localCardId);
        const outbox = outboxForCard(snap, helpRow.localCardId);
        if (sup?.state !== "accepted" || !outbox || outbox.sentAt === null) return null;
        return snap;
      }, 10 * 60_000);

      const requesterContribution = contributionFor(requester, requestId);
      const finalHelp = helpRequestFor(finalReceiver, requestId);
      if (!requesterContribution || !finalHelp) throw new Error("recovery did not converge");
      const requesterEvents = requester.contributionEvents.filter((e) => e.requestId === requestId);
      if (requesterEvents.length !== 1) throw new Error(`recovery produced ${requesterEvents.length} requester events (expected 1)`);
      const receiverCards = cardsForSourceId(finalReceiver, requestId).filter((c) => c.type === "O");
      if (receiverCards.length !== 1) throw new Error(`recovery produced ${receiverCards.length} receiver cards (expected 1)`);
      scenario.evidence.push({ kind: "request", id: requestId }, { kind: "event", id: requesterEvents[0]?.eventId ?? "" });
      ctx.onEvent({ ts: ctx.now().toISOString(), stage: "recovery-restarts", node: "controller", message: "recovery converged without duplicate custody" });
    }, 25 * 60_000));
  }

  scenarios.push(await runScenario(ctx, "ambiguous-dispatch", "ambiguous dispatch window convergence", async (scenario) => {
    const requestId = `swarm-${ctx.runId}-ambiguous`;
    ctx.tracked.requestIds.push(requestId);
    const goal = `${runMarker(ctx.runId)} Reply with exactly the single word: ok. Do nothing else.`;
    const delegateResult = await ctx.delegate(
      { peer: ctx.profile.receiverPeerName, goal, request_id: requestId, priority: "MEDIUM" },
      "requester",
    );
    if (!delegateResult.ok) throw new Error(`ambiguous delegation failed: ${delegateResult.error ?? "unknown"}`);
    if (delegateResult.decision === "accepted") {
      ctx.tracked.requesterProxyCards.push(delegateResult.proxyCardId ?? 0);
      ctx.tracked.requesterRootCards.push(delegateResult.projectCardId ?? 0);
      ctx.tracked.contributionRefs.push(delegateResult.contributionRef ?? "");
    }
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "ambiguous-dispatch", node: "controller", message: `ambiguous request admitted as ${delegateResult.decision}; restarting receiver around the reservation` });

    const receiverBefore = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const help = helpRequestFor(snap, requestId);
      if (help && (help.state === "accepted" || help.state === "pending")) return snap;
      const cards = cardsForSourceId(snap, requestId);
      if (cards.length > 0) return snap;
      return null;
    }, 3 * 60_000);
    const helpBefore = helpRequestFor(receiverBefore, requestId);

    await restartReceiver(ctx);

    const receiver = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const help = helpRequestFor(snap, requestId);
      const cards = cardsForSourceId(snap, requestId);
      if (help && help.state === "accepted" && cards.length > 0) return snap;
      return null;
    }, 10 * 60_000);
    const help = helpRequestFor(receiver, requestId);
    const receiverCards = cardsForSourceId(receiver, requestId).filter((c) => c.type === "O");
    if (receiverCards.length > 1) throw new Error(`ambiguous dispatch created ${receiverCards.length} receiver projects (expected at most 1)`);

    const requester = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
      const contribution = contributionFor(snap, requestId);
      if (!contribution) return null;
      if (contribution.state === "completed" || contribution.state === "declined" || contribution.state === "failed") return snap;
      return null;
    }, 10 * 60_000);
    const contribution = contributionFor(requester, requestId);
    if (!contribution) throw new Error("ambiguous dispatch left no requester outcome");
    const events = requester.contributionEvents.filter((e) => e.requestId === requestId);
    if (events.length > 1) throw new Error(`ambiguous dispatch produced ${events.length} requester events (expected at most 1)`);
    if (helpBefore?.localCardId && helpBefore.localCardId !== help?.localCardId) {
      throw new Error("ambiguous dispatch re-admitted onto a different receiver project");
    }
    scenario.evidence.push({ kind: "request", id: requestId });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "ambiguous-dispatch", node: "controller", message: `ambiguous dispatch converged: ${receiverCards.length} project(s), ${events.length} requester terminal event(s)` });
  }, 20 * 60_000));

  scenarios.push(await runScenario(ctx, "remote-pi-lane", "remote Pi lifecycle and signed control", async (scenario) => {
    if (ctx.orcCall === null) {
      scenario.state = "blocked";
      scenario.failure = { stage: "remote-pi-lane", code: "NO_ORC_SURFACE", message: "no requester TUI/chat surface configured; the remote Pi lane is Orc-driven" };
      return;
    }
    const requestId = `swarm-${ctx.runId}-pi`;
    ctx.tracked.requestIds.push(requestId);
    const alias = ctx.profile.receiverWorkspaceAlias;

    const receiverPreflight = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "preflight", peer: ctx.profile.requesterPeerName, requirePiAlias: alias }, 120_000);
    if (receiverPreflight.kind !== "preflight") throw new Error("receiver preflight probe returned unexpected kind");
    if (!receiverPreflight.value.capabilities.piExecutorConfigured || !receiverPreflight.value.capabilities.workspaceAliasPresent) {
      throw new Error("receiver lacks the disposable workspace alias or Pi executor configuration");
    }

    const goal = `${REMOTE_SWARM_DEV_TEST_PREFIX} ${runMarker(ctx.runId)} Use the peer_ask_help tool exactly once with peer "${ctx.profile.receiverPeerName}", request_id "${requestId}", executor "pi", workspace_alias "${alias}", and goal "Implement a minimal single-file script that prints the word ok, then stop. Do not commit anything." Report the tool result verbatim.`;
    const reply = await ctx.orcCall.call(goal, { timeoutMs: 12 * 60_000 });
    scenario.evidence.push({ kind: "chat", id: reply.sessionId ?? "tui" });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "remote-pi-lane", node: "requester", message: `pi delegation requested via requester Orc (${reply.reply.length} chars)` });

    const requesterAccepted = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
      const contribution = contributionFor(snap, requestId);
      if (!contribution || contribution.state !== "accepted") return null;
      const proxy = cardsForSourceId(snap, requestId).find((c) => c.type === "contribution");
      if (!proxy?.notesRemoteRunId) return null;
      return snap;
    }, 8 * 60_000);
    const acceptedProxy = cardsForSourceId(requesterAccepted, requestId).find((c) => c.type === "contribution");
    const piRunId = acceptedProxy?.notesRemoteRunId ?? "";
    if (!piRunId) throw new Error("requester accepted the Pi contribution without a remote run id");
    ctx.tracked.piRunIds.push(piRunId);
    scenario.evidence.push({ kind: "run", id: piRunId });

    const receiverRun = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const run = piRunFor(snap, piRunId);
      if (run && (run.status === "running" || run.status === "starting")) return snap;
      return null;
    }, 8 * 60_000);
    const run = piRunFor(receiverRun, piRunId);
    if (!run) throw new Error("receiver Pi run vanished");
    const generation = run.generation;

    const status = await ctx.probes.run({
      version: 1, role: "requester", runId: ctx.runId, command: "remote-pi-control",
      peer: ctx.profile.receiverPeerName,
      pi: { action: "status", piRunId, generation, commandId: `rs-status-${ctx.runId}` },
    }, 120_000);
    if (status.kind !== "control") throw new Error("control probe returned unexpected kind");
    if (status.value.outcome !== "succeeded" || status.value.projection?.status !== "running") {
      throw new Error(`signed status control did not succeed (${status.value.outcome} ${status.value.error?.code ?? ""})`);
    }

    const steer = await ctx.probes.run({
      version: 1, role: "requester", runId: ctx.runId, command: "remote-pi-control",
      peer: ctx.profile.receiverPeerName,
      pi: { action: "steer", piRunId, generation, commandId: `rs-steer-${ctx.runId}`, instruction: "Keep it minimal; the single word output suffices." },
    }, 120_000);
    if (steer.kind !== "control") throw new Error("control probe returned unexpected kind");
    if (steer.value.outcome === "rejected" && steer.value.error?.code !== "INVALID_STATE") {
      throw new Error(`signed steer was rejected unexpectedly: ${steer.value.error?.code}`);
    }

    await restartReceiver(ctx);
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "remote-pi-lane", node: "controller", message: "receiver (owner) restarted mid-run" });

    const resumedRun = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const row = piRunFor(snap, piRunId);
      if (row && (row.status === "interrupted" || row.status === "running" || row.status === "completed")) return snap;
      return null;
    }, 8 * 60_000);
    const resumedRow = piRunFor(resumedRun, piRunId);
    if (!resumedRow) throw new Error("Pi run vanished after owner restart");

    if (resumedRow.status === "interrupted" && ctx.allowResume) {
      const resumeCommandId = `rs-resume-${ctx.runId}`;
      const approval = buildResumeApproval({ runId: piRunId, generation: resumedRow.generation, commandId: resumeCommandId, originPeer: ctx.profile.receiverPeerName, now: ctx.now });
      const resume = await ctx.probes.run({
        version: 1, role: "requester", runId: ctx.runId, command: "remote-pi-control",
        peer: ctx.profile.receiverPeerName,
        pi: { action: "resume", piRunId, generation: resumedRow.generation, commandId: resumeCommandId, approval },
      }, 120_000);
      if (resume.kind !== "control") throw new Error("resume control probe returned unexpected kind");
      if (resume.value.outcome !== "succeeded") {
        throw new Error(`signed resume was rejected: ${resume.value.error?.code ?? resume.value.outcome}`);
      }
      ctx.onEvent({ ts: ctx.now().toISOString(), stage: "remote-pi-lane", node: "controller", message: "signed one-use resume approval accepted" });
      const afterResume = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
        const row = piRunFor(snap, piRunId);
        if (row && row.status === "running") return snap;
        return null;
      }, 8 * 60_000);
      const resumedRow2 = piRunFor(afterResume, piRunId);
      if (!resumedRow2) throw new Error("Pi run vanished after resume");
      if (resumedRow2.generation <= resumedRow.generation) throw new Error("resume did not advance the execution generation");
    }

    const currentSnapshot = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "snapshot", requestIds: [requestId], marker: ctx.marker }, 120_000);
    if (currentSnapshot.kind !== "snapshot") throw new Error("receiver snapshot probe returned unexpected kind");
    const currentRow = piRunFor(currentSnapshot.value, piRunId);
    if (!currentRow) throw new Error("Pi run vanished before cancellation");
    const cancel = await ctx.probes.run({
      version: 1, role: "requester", runId: ctx.runId, command: "remote-pi-control",
      peer: ctx.profile.receiverPeerName,
      pi: { action: "cancel", piRunId, generation: currentRow.generation, commandId: `rs-cancel-${ctx.runId}` },
    }, 120_000);
    if (cancel.kind !== "control") throw new Error("cancel control probe returned unexpected kind");
    if (cancel.value.outcome !== "succeeded") {
      throw new Error(`signed cancel was rejected: ${cancel.value.error?.code ?? cancel.value.outcome}`);
    }

    const terminalRun = await pollSnapshot(ctx, "receiver", [requestId], ctx.marker, (snap) => {
      const row = piRunFor(snap, piRunId);
      if (row && (row.status === "cancelled" || row.status === "failed" || row.status === "completed")) return snap;
      return null;
    }, 8 * 60_000);
    const terminalRow = piRunFor(terminalRun, piRunId);
    if (!terminalRow) throw new Error("Pi run did not reach a terminal state");

    const originProjection = await pollSnapshot(ctx, "requester", [requestId], ctx.marker, (snap) => {
      const projection = originProjectionFor(snap, piRunId);
      if (projection && (projection.latestStatus === "cancelled" || projection.latestStatus === "failed" || projection.latestStatus === "completed")) return snap;
      return null;
    }, 8 * 60_000);
    const projection = originProjectionFor(originProjection, piRunId);
    if (!projection) throw new Error("requester origin projection did not reach a terminal status");
    if (projection.acknowledgedSequence < projection.latestSequence) {
      throw new Error(`origin projection cursor is behind: ${projection.acknowledgedSequence} < ${projection.latestSequence}`);
    }

    scenario.evidence.push({ kind: "run", id: piRunId });
    ctx.onEvent({ ts: ctx.now().toISOString(), stage: "remote-pi-lane", node: "controller", message: `pi lane terminal: run=${piRunId} status=${terminalRow.status}` });
  }, 28 * 60_000));

  return scenarios;
}

export function buildResumeApproval(input: {
  runId: string;
  generation: number;
  commandId: string;
  originPeer: string;
  now: () => Date;
}): RemoteSwarmResumeApprovalV1 {
  const issuedAt = input.now().toISOString();
  const expiresAt = new Date(input.now().getTime() + 5 * 60_000).toISOString();
  const approvalId = `rs-approval-${input.runId}-${randomUUID().slice(0, 8)}`;
  const statement = JSON.stringify({
    approval_id: approvalId,
    run_id: input.runId,
    origin_peer: input.originPeer,
    command_id: input.commandId,
    approving_principal: input.originPeer,
    issued_at: issuedAt,
    expires_at: expiresAt,
    interrupted_generation: input.generation,
  });
  return {
    approvalId,
    runId: input.runId,
    originPeer: input.originPeer,
    commandId: input.commandId,
    approvingPrincipal: input.originPeer,
    issuedAt,
    expiresAt,
    interruptedGeneration: input.generation,
    approvalStatementSha256: createHash("sha256").update(statement, "utf-8").digest("hex"),
  };
}

async function stopRequester(ctx: ScenarioContext): Promise<void> {
  const node = ctx.profile.requester;
  const cli = node.cli ?? "abtars";
  const result = await ctx.probes.portFor("requester").run([
    { text: cli, quote: false },
    { text: "stop", quote: false },
  ], { timeoutMs: 180_000, cwd: node.workdir });
  if (!result.ok && !result.timedOut) throw new Error(`abtars stop failed: ${result.stderr.slice(0, 300)}`);
  await pollUntil("requester-stopped", async () => {
    const preflight = await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "preflight" }, 120_000);
    if (preflight.kind !== "preflight") return null;
    return preflight.value.bridge.running ? null : true;
  }, 240_000, { intervalMs: 3_000, sleep: ctx.sleep });
}

async function startRequester(ctx: ScenarioContext): Promise<void> {
  const node = ctx.profile.requester;
  const cli = node.cli ?? "abtars";
  const result = await ctx.probes.portFor("requester").run([
    { text: cli, quote: false },
    { text: "start", quote: false },
  ], { timeoutMs: 180_000, cwd: node.workdir });
  if (!result.ok) throw new Error(`abtars start failed: ${result.stderr.slice(0, 300)}`);
  await pollUntil("requester-started", async () => {
    const preflight = await ctx.probes.run({ version: 1, role: "requester", runId: ctx.runId, command: "preflight", peer: ctx.profile.receiverPeerName }, 120_000);
    if (preflight.kind !== "preflight") return null;
    if (!preflight.value.bridge.running || !preflight.value.bridge.heartbeatFresh) return null;
    return preflight.value.route.expectedPeerRoute ? preflight : null;
  }, 360_000, { intervalMs: 5_000, sleep: ctx.sleep });
}

async function restartReceiver(ctx: ScenarioContext): Promise<void> {
  const node = ctx.profile.receiver;
  const cli = node.cli ?? "abtars";
  const result = await ctx.probes.portFor("receiver").run([
    { text: cli, quote: false },
    { text: "restart", quote: false },
  ], { timeoutMs: 300_000, cwd: node.workdir });
  if (!result.ok && !result.timedOut) throw new Error(`abtars restart failed on receiver: ${result.stderr.slice(0, 300)}`);
  await pollUntil("receiver-started", async () => {
    const preflight = await ctx.probes.run({ version: 1, role: "receiver", runId: ctx.runId, command: "preflight", peer: ctx.profile.requesterPeerName }, 120_000);
    if (preflight.kind !== "preflight") return null;
    if (!preflight.value.bridge.running || !preflight.value.bridge.heartbeatFresh) return null;
    return preflight;
  }, 480_000, { intervalMs: 5_000, sleep: ctx.sleep });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export async function runCleanup(ctx: ScenarioContext): Promise<RemoteSwarmCleanupResultV1> {
  const assertions: RemoteSwarmCleanupResultV1["assertions"] = [];
  try {
    const { requester, receiver } = await snapshotBoth(ctx, ctx.tracked.requestIds, ctx.marker);
    const requestIds = ctx.tracked.requestIds;

    for (const requestId of requestIds) {
      const contribution = contributionFor(requester, requestId);
      const inbound = helpRequestFor(requester, requestId);
      const terminalStates = new Set(["accepted", "running", "completed", "declined", "deferred", "failed", "withdrawal_noted", "unknown"]);
      const settled = (contribution !== undefined && terminalStates.has(contribution.state))
        || (inbound !== undefined && (inbound.state === "accepted" || inbound.state === "declined" || inbound.state === "unknown"));
      assertions.push({
        id: `request-${requestId}`,
        passed: settled,
        detail: contribution ? `contribution=${contribution.state}` : inbound ? `help=${inbound.state}` : "no requester settlement",
      });
    }
    for (const proxyId of ctx.tracked.requesterProxyCards) {
      const card = cardById(requester, proxyId);
      const terminal = card !== undefined && (card.status === "delivered" || card.status === "done" || card.status === "failed");
      assertions.push({ id: `proxy-${proxyId}`, passed: terminal, detail: card ? `status=${card.status}` : "missing card" });
    }
    for (const cardId of ctx.tracked.receiverCards) {
      const card = cardById(receiver, cardId);
      const terminal = card !== undefined && (card.status === "delivered" || card.status === "done" || card.status === "failed");
      assertions.push({ id: `receiver-card-${cardId}`, passed: terminal, detail: card ? `status=${card.status}` : "missing card" });
    }
    for (const runId of ctx.tracked.piRunIds) {
      const run = piRunFor(receiver, runId);
      const terminal = run !== undefined && ["completed", "failed", "cancelled"].includes(run.status);
      assertions.push({ id: `pi-run-${runId}`, passed: terminal, detail: run ? `status=${run.status}` : "missing run" });
      const claims = receiver.workspaceClaims.filter((c) => c.runId === runId);
      assertions.push({ id: `pi-claims-${runId}`, passed: claims.length === 0, detail: `${claims.length} workspace claim(s) remain` });
      const liveAttempts = receiver.workerAttempts.filter((a) => a.executorId === runId && !["completed", "failed", "cancelled", "timed_out"].includes(a.lifecycle));
      assertions.push({ id: `pi-attempts-${runId}`, passed: liveAttempts.length === 0, detail: `${liveAttempts.length} live attempt(s) remain` });
      const liveCommands = receiver.piCommands.filter((c) => c.runId === runId && !["completed", "rejected", "outcome_unknown"].includes(c.state));
      assertions.push({ id: `pi-commands-${runId}`, passed: liveCommands.length === 0, detail: `${liveCommands.length} live command(s) remain` });
      const unacked = receiver.piEvents.filter((e) => e.runId === runId && e.acknowledgedAt === null);
      assertions.push({ id: `pi-events-${runId}`, passed: unacked.length === 0, detail: `${unacked.length} unacknowledged event(s) remain` });
      const liveProcess = receiver.processFacts.find((p) => p.runId === runId);
      assertions.push({ id: `pi-process-${runId}`, passed: liveProcess === undefined || !liveProcess.observedPidPresent, detail: liveProcess ? `observedPidPresent=${liveProcess.observedPidPresent}` : "no process facts" });
      const projection = originProjectionFor(requester, runId);
      assertions.push({
        id: `pi-projection-${runId}`,
        passed: projection !== undefined && ["completed", "failed", "cancelled"].includes(projection.latestStatus),
        detail: projection ? `latestStatus=${projection.latestStatus}` : "no origin projection",
      });
    }
  } catch (err) {
    assertions.push({
      id: "cleanup-snapshot",
      passed: false,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
  const failed = assertions.filter((a) => !a.passed);
  return {
    state: failed.length === 0 ? "passed" : "failed",
    assertions,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface SwarmLiveDeps {
  profile: RemoteSwarmLiveProfileV1;
  profileName: RemoteSwarmProfileName;
  runId: string;
  expectedCommit: string;
  allowRestarts: boolean;
  allowResume: boolean;
  requesterPort: CommandPort;
  receiverPort: CommandPort;
  delegate: HttpDelegatePort;
  orcCall?: OrcCallPort;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (record: RemoteSwarmEventRecordV1) => void;
  probeTimeoutMs?: number;
}

export async function runRemoteSwarmLiveE2E(deps: SwarmLiveDeps): Promise<RemoteSwarmLiveResultV1> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const onEvent = deps.onEvent ?? (() => {});
  const probeTimeoutMs = deps.probeTimeoutMs ?? 120_000;

  const startedAt = now().toISOString();
  const marker = runMarker(deps.runId);
  const profile = deps.profile;
  const writer = new EvidenceWriter(profile.evidenceRoot, deps.runId);
  const writerEvent = (record: RemoteSwarmEventRecordV1): void => {
    onEvent(record);
    writer.appendEvent(record);
  };

  const probes = new ProbeClient(profile, deps.requesterPort, deps.receiverPort, writerEvent, probeTimeoutMs);
  const orcCall = deps.orcCall ?? null;

  const ctx: ScenarioContext = {
    runId: deps.runId,
    marker,
    profile,
    expectedCommit: deps.expectedCommit,
    allowRestarts: deps.allowRestarts,
    allowResume: deps.allowResume,
    probes,
    delegate: deps.delegate,
    orcCall,
    onEvent: writerEvent,
    now,
    sleep,
    tracked: newTrackedObjects(),
  };

  const scenarios: RemoteSwarmScenarioResultV1[] = [];
  let overallState: RemoteSwarmLiveResultV1["state"] = "passed";
  let overallFailure: RemoteSwarmLiveResultV1["failure"] = null;

  try {
    const preflightScenario = await runScenario(ctx, "preflight", "node preflight and compatibility", async () => {
      await preflightNodes(ctx);
    }, 5 * 60_000);
    scenarios.push(preflightScenario);
    if (preflightScenario.state !== "passed") {
      overallState = preflightScenario.state;
      overallFailure = preflightScenario.failure;
    } else {
      const cleanScenario = await runScenario(ctx, "clean-prior-run-id", "no prior objects for this run id", async () => {
        const { requester, receiver } = await snapshotBoth(ctx, [], marker);
        if (requester.cards.length > 0 || receiver.cards.length > 0) {
          throw new Error(`prior run objects found for ${deps.runId} on requester=${requester.cards.length} receiver=${receiver.cards.length}`);
        }
      }, 3 * 60_000);
      scenarios.push(cleanScenario);
      if (cleanScenario.state !== "passed") {
        overallState = cleanScenario.state;
        overallFailure = cleanScenario.failure;
      } else if (deps.profileName === "foundation") {
        scenarios.push(...await runFoundation(ctx));
      } else {
        scenarios.push(...await runFull(ctx));
      }
    }
  } catch (err) {
    overallState = "failed";
    overallFailure = { stage: "orchestration", code: "CONTROLLER_FAILED", message: (err instanceof Error ? err.message : String(err)).slice(0, bounds.message) };
  }

  const failedOrBlocked = scenarios.filter((s) => s.state !== "passed");
  if (overallState === "passed" && failedOrBlocked.length > 0) {
    overallState = failedOrBlocked.some((s) => s.state === "failed") ? "failed" : "blocked";
    overallFailure = failedOrBlocked[0]?.failure ?? null;
  }

  const cleanup = await runCleanup(ctx);
  if (cleanup.state !== "passed" && overallState === "passed") {
    overallState = "failed";
    overallFailure = { stage: "cleanup", code: "CLEANUP_FAILED", message: `cleanup assertions failed: ${cleanup.assertions.filter((a) => !a.passed).slice(0, 3).map((a) => a.id).join(", ")}` };
  }

  const result = buildResult(deps, now, startedAt, scenarios, cleanup, overallState, overallFailure);
  writer.writeResult(result);
  writer.writeJunit(result);

  if (overallState !== "passed") {
    try {
      const requesterTail = await probes.run({ version: 1, role: "requester", runId: deps.runId, command: "log-tail", lines: 200 }, 60_000);
      const receiverTail = await probes.run({ version: 1, role: "receiver", runId: deps.runId, command: "log-tail", lines: 200 }, 60_000);
      if (requesterTail.kind === "log-tail") writer.writeFailureTail("requester-tail.log", requesterTail.value.tail);
      if (receiverTail.kind === "log-tail") writer.writeFailureTail("receiver-tail.log", receiverTail.value.tail);
    } catch { /* tails are best-effort evidence, never part of the gate */ }
  }

  const validation = validateLiveResult(result);
  if (!validation.ok) {
    throw new Error(`controller produced an invalid result: ${validation.error}`);
  }
  return result;
}

function buildResult(
  deps: SwarmLiveDeps,
  now: () => Date,
  startedAt: string,
  scenarios: RemoteSwarmScenarioResultV1[],
  cleanup: RemoteSwarmCleanupResultV1,
  state: RemoteSwarmLiveResultV1["state"],
  failure: RemoteSwarmLiveResultV1["failure"],
): RemoteSwarmLiveResultV1 {
  return {
    version: 1,
    runId: deps.runId,
    profile: deps.profileName,
    expectedCommit: deps.expectedCommit,
    requesterBuild: "",
    receiverBuild: "",
    startedAt,
    finishedAt: now().toISOString(),
    state,
    scenarios,
    cleanup,
    failure,
  };
}

async function preflightNodes(ctx: ScenarioContext): Promise<void> {
  const requester = await ctx.probes.run({
    version: 1, role: "requester", runId: ctx.runId, command: "preflight",
    expectedCommit: ctx.expectedCommit, peer: ctx.profile.receiverPeerName,
  }, 120_000);
  const receiver = await ctx.probes.run({
    version: 1, role: "receiver", runId: ctx.runId, command: "preflight",
    expectedCommit: ctx.expectedCommit, peer: ctx.profile.requesterPeerName,
  }, 120_000);
  if (requester.kind !== "preflight" || receiver.kind !== "preflight") throw new Error("preflight probes returned unexpected kinds");
  const rq = requester.value;
  const rv = receiver.value;
  if (!rq.build.matchesExpected || !rv.build.matchesExpected) {
    throw new Error(`deployed builds do not match ${ctx.expectedCommit} (requester=${rq.build.commit ?? "none"} receiver=${rv.build.commit ?? "none"})`);
  }
  if (!rq.bridge.running || !rv.bridge.running) throw new Error("one or both bridges are not running");
  if (!rq.bridge.heartbeatFresh || !rv.bridge.heartbeatFresh) throw new Error("one or both bridge heartbeats are stale");
  if (!rq.route.expectedPeerRoute || !rv.route.expectedPeerRoute) throw new Error("the requester-receiver peer route is not established");
  if (!rq.route.authenticated || !rv.route.authenticated) throw new Error("the peer route is not authenticated");
  if (!rq.enrollment.selfEnrolled || !rv.enrollment.selfEnrolled) throw new Error("one or both nodes are not self-enrolled");
  if (!rq.credentials.transportJson || !rq.credentials.providerSecretPresent) throw new Error("requester model provider is not configured");
  if (!rq.credentials.modelsJson || !rq.credentials.usersJson) throw new Error("requester config is incomplete");
  if (!rq.peerApi.runtimeSnapshotPresent || !rv.peerApi.runtimeSnapshotPresent) throw new Error("runtime health snapshots are missing");
}

async function main(): Promise<void> {
  const args = parseControllerArgs(process.argv.slice(2));
  const rawProfile = JSON.parse(readFileSync(args.profileFile, "utf-8")) as unknown;
  const validation = validateProfile(rawProfile);
  if (!validation.ok) throw new Error(`profile invalid: ${validation.error}`);
  const profile = validation.value;
  const runId = args.runId ?? buildRunId(new Date());
  if (args.profile === "full" && !args.allowRestarts) {
    throw new Error("the full profile requires --allow-restarts");
  }

  const requesterPort = new LocalCommandPort();
  const receiverPort = new TmuxCommandPort({ session: profile.receiver.exec.kind === "tmux" ? profile.receiver.exec.session : "remote" });
  const delegate = createHttpDelegatePort(profile, receiverPort);
  const orcCall = profile.tui?.socketPath ? new TuiOrcClient({ socketPath: profile.tui.socketPath }) : null;
  if (args.profile === "full" && orcCall === null) {
    throw new Error("the full profile requires a requester TUI socket (profile.tui.socketPath)");
  }

  const result = await runRemoteSwarmLiveE2E({
    profile,
    profileName: args.profile,
    runId,
    expectedCommit: args.expectedCommit,
    allowRestarts: args.allowRestarts,
    allowResume: args.allowResume,
    requesterPort,
    receiverPort,
    delegate,
    orcCall: orcCall ?? undefined,
  });

  console.log(JSON.stringify({ runId, profile: args.profile, state: result.state, scenarios: result.scenarios.map((s) => ({ id: s.id, state: s.state })), evidenceRoot: `${profile.evidenceRoot}/${runId}` }, null, 2));
  process.exitCode = result.state === "passed" ? 0 : 1;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main().catch((err) => {
    console.error(`remote-swarm-live-e2e failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });
}
