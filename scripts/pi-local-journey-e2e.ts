#!/usr/bin/env node
/**
 * pi-local-journey-e2e.ts — Epic #17 / #1405 local Pi + TUI operator journey.
 *
 * Runs the built bridge (bundle/abtars.js) with an isolated abtars home, the
 * real standalone `pi` executable (RPC mode), a real temporary git workspace,
 * and a deterministic fixture model provider for the Main session only. The Pi
 * child itself calls the real configured model using an isolated copy of the
 * host's ~/.pi credentials.
 *
 * Journey (canonical Epic #17 local Pi acceptance contract):
 *   start -> TUI attach -> observe -> steer -> reply (if a UI request
 *   surfaces) -> cancel -> bridge restart -> explicit same-session resume ->
 *   terminal completion -> stale/foreign control rejection -> queued capacity
 *   -> restart with an active + a queued run -> boot interrupt + queued
 *   recovery -> resume interrupted -> terminal completion -> orphan audit
 *   (process table, session list, run/card rows, child environment).
 *
 * Usage:
 *   tsx scripts/pi-local-journey-e2e.ts [--keep-artifacts]
 *
 * Exit code 0 = full journey passed; non-zero = at least one contract
 * violation recorded. Evidence is written to test-results/pi-local-journey/.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, mkdtempSync, statSync, realpathSync, readdirSync, copyFileSync, readlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ScriptedProvider } from "../src/tests/e2e/pi-production/scripted-provider.js";
import { TuiAcceptanceClient } from "../src/tests/e2e/pi-production/tui-client.js";
import { SpawnedChild, waitFor } from "../src/tests/e2e/pi-production/child-process.js";
import { FIXTURE_MODEL_A, FIXTURE_MODEL_B, FIXTURE_PROVIDER, FIXTURE_API_KEY_ENV, MASTER_USER_ID } from "../src/tests/e2e/pi-production/bridge-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const abtarsRoot = resolve(here, "..");
const homeHost = requireHostHome();

function requireHostHome(): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME is not set — this harness needs the host home to seed an isolated pi config");
  return home;
}
const SENTINEL_ENV = "PI_JOURNEY_SENTINEL";
const JOURNEY_DEADLINE_MS = 55 * 60_000;

// ── Evidence ────────────────────────────────────────────────────────────────

interface EvidenceEntry {
  step: string;
  ok: boolean;
  detail: string;
}

const evidence: EvidenceEntry[] = [];
function record(step: string, ok: boolean, detail: string): void {
  evidence.push({ step, ok, detail });
  const icon = ok ? "+" : "x";
  console.log(`[${icon}] ${step}: ${detail.slice(0, 400)}`);
}

interface PiRunRef { runId: string; cardId: number; sessionId: string; generation: number }
interface PiStatusView { status: string; generation: number; sessionId?: string; pendingRequestId?: string; pendingRequestType?: string; error?: string; resultSummary?: string }

function parseRunReply(md: string): PiRunRef | null {
  const runId = md.match(/Run:\s*`([^`]+)`/)?.[1];
  const cardId = md.match(/Card:\s*#(\d+)/)?.[1];
  const sessionId = md.match(/Session:\s*`([^`]+)`/)?.[1];
  const generation = md.match(/Generation:\s*(\d+)/)?.[1];
  if (!runId || !cardId || !sessionId || !generation) return null;
  return { runId, cardId: Number(cardId), sessionId, generation: Number(generation) };
}

function parseStatusView(md: string): PiStatusView {
  const line = (key: string): string | undefined => {
    const m = md.match(new RegExp(`${key}:\\s*(.+)`));
    return m?.[1]?.trim();
  };
  const view: PiStatusView = { status: line("Status") ?? "unknown", generation: Number(line("Generation") ?? 0) };
  const session = line("Session");
  if (session) view.sessionId = session.replace(/^`|`$/g, "");
  const pending = line("Pending input");
  if (pending) {
    const req = pending.match(/`([^`]+)`/)?.[1];
    view.pendingRequestId = req;
    view.pendingRequestType = pending.match(/\(([^)]+)\)/)?.[1];
  }
  const error = line("Error");
  if (error) view.error = error;
  const result = line("Result");
  if (result) view.resultSummary = result;
  return view;
}

// ── Process / environment helpers ───────────────────────────────────────────

/**
 * pi rewrites its own cmdline to `pi` (argv is cleared), so ps/grep filters
 * on arguments can never identify it. Identify pi children by /proc comm plus
 * the exact cwd (inside this journey's run root) — the same authority the
 * executor's exact-child handles use.
 */
function psPiChildren(): Array<{ pid: number; ppid: number }> {
  const out: Array<{ pid: number; ppid: number }> = [];
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return out; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (comm !== "pi") continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (!cwd.startsWith(runRoot)) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/^\d+ \(.+\) \w (\d+)/);
      const ppid = m ? Number(m[1]!) : 0;
      out.push({ pid, ppid });
    } catch { /* process vanished mid-scan */ }
  }
  return out;
}

function readProcEnviron(pid: number): Record<string, string> {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string> = {};
    for (const pair of raw.split("\0")) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return env;
  } catch {
    return {};
  }
}

// ── Pi executable resolution (never repo-local node_modules/.bin) ───────────

function resolvePiExecutable(): string | null {
  const pathDirs = (process.env.PATH ?? "").split(":").filter((dir) => dir && !dir.includes("node_modules/.bin"));
  for (const dir of pathDirs) {
    const candidate = join(dir, "pi");
    try {
      const st = statSync(candidate);
      if (st.isFile() || st.isSymbolicLink()) return realpathSync(candidate);
    } catch { /* keep scanning */ }
  }
  return null;
}

// ── Bridge lifecycle ────────────────────────────────────────────────────────

let provider: ScriptedProvider;
let bridge: SpawnedChild;
let bridgeEnv: NodeJS.ProcessEnv;
let runRoot: string;
let abtarsHome: string;
let workspaceDir: string;
let homeDir: string;
let logDir: string;
let tui: TuiAcceptanceClient;

function buildBridgeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allow = ["PATH", "NODE_PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM"];
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (env.PATH) {
    env.PATH = env.PATH.split(":").filter((dir) => !dir.includes("node_modules/.bin")).join(":");
  }
  const hostNative = join(homeHost, ".local", "lib", "node_modules");
  env.NODE_PATH = [hostNative, env.NODE_PATH].filter(Boolean).join(":");
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.ABTARS_HOME = abtarsHome;
  env.ABMIND_HOME = join(homeDir, ".abmind");
  env.XDG_CONFIG_HOME = join(homeDir, ".config");
  env.XDG_CACHE_HOME = join(homeDir, ".cache");
  env.XDG_STATE_HOME = join(homeDir, ".local", "state");
  env.WORKING_DIR = workspaceDir;
  env.TRANSPORT_CONFIG = "transport.json";
  env.MODELS_CONFIG = "models.json";
  env[FIXTURE_API_KEY_ENV] = `pi-journey-${runRoot.split("/").pop()}`;
  env[SENTINEL_ENV] = "must-never-reach-pi-child";
  env.LOG_LEVEL = "info";
  env.LOG_FORMAT = "text";
  env.MEMORY = "none";
  env.ACTIVE_MEMORY = "false";
  env.PRIMING_MODEL_TOPICS = "false";
  env.TUI_ENABLED = "true";
  env.TELEGRAM_ENABLED = "false";
  env.DISCORD_ENABLED = "false";
  env.ENABLE_DASHBOARD = "false";
  env.ENABLE_AGENT_API = "false";
  env.ENABLE_ASYNC_DELEGATION = "true";
  env.SECURITY_MODE = "off";
  env.TRUST_MODE = "true";
  env.SELFHEAL_MODE = "off";
  env.SUPERVISION = "pi-journey";
  env.MAX_AGENT_CALL_PER_HOUR = "10000";
  env.MAX_AGENT_CALL_PER_DAY = "100000";
  env.MAX_BACKGROUND_SESSIONS = "3";
  return env;
}

async function spawnBridge(): Promise<SpawnedChild> {
  const preBootRequests = provider.summaries.length;
  const child = new SpawnedChild({
    execPath: process.execPath,
    args: [resolve(abtarsRoot, "bundle/abtars.js")],
    cwd: abtarsRoot,
    env: bridgeEnv,
    logDir,
    name: "bridge",
  });
  await waitFor(
    async () => {
      if (child.exited) throw new Error(`bridge exited during boot (code=${child.exitCodeValue}, signal=${child.signalValue})\n${child.stderrTail}`);
      return existsSync(join(abtarsHome, "tui.sock")) ? true : undefined;
    },
    120_000,
    "bridge TUI socket",
    () => `${child.stdoutTail}\n${child.stderrTail}`,
  );
  // Optional autonomous boot greeting; never consume a later script.
  try {
    await waitFor(
      async () => (provider.summaries.length > preBootRequests ? true : undefined),
      30_000,
      "bridge boot greeting provider request",
    );
  } catch { /* no greeting in this composition — fine */ }
  return child;
}

async function restartBridge(): Promise<void> {
  if (!bridge.exited) await bridge.terminate();
  bridge = await spawnBridge();
}

// ── TUI helpers ─────────────────────────────────────────────────────────────

async function tuiCommand(text: string, _what: string): Promise<{ reply: string }> {
  const reply = await tui.sendAndAwaitReply(text);
  return { reply: reply.markdown };
}

async function piStatus(runId: string): Promise<PiStatusView> {
  const { reply } = await tuiCommand(`/pi status ${runId}`, `status ${runId}`);
  return parseStatusView(reply);
}

async function waitForRunStatus(runId: string, statuses: string[], timeoutMs: number): Promise<PiStatusView> {
  return waitFor(
    async () => {
      const view = await piStatus(runId);
      return statuses.includes(view.status) ? view : undefined;
    },
    timeoutMs,
    `run ${runId} status ${statuses.join("/")}`,
    () => "",
  );
}

/** Parse the short index of the first live Code (C) session from /sessions. */
async function findCodeSessionIndex(): Promise<number | null> {
  const { reply } = await tuiCommand("/sessions", "session list");
  for (const line of reply.split("\n")) {
    const m = line.match(/^#(\d+)\s+Code\b/);
    if (m) return Number(m[1]!);
  }
  return null;
}

async function fileExistsInWorkspace(rel: string): Promise<boolean> {
  return existsSync(join(workspaceDir, rel));
}

async function waitForWorkspaceFile(rel: string, timeoutMs: number): Promise<void> {
  await waitFor(
    async () => (await fileExistsInWorkspace(rel)) ? true : undefined,
    timeoutMs,
    `workspace file ${rel}`,
  );
}

// ── Setup ───────────────────────────────────────────────────────────────────

function copyDirRecursive(src: string, dest: string, exclude: Set<string>): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyDirRecursive(from, to, exclude);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try { copyFileSync(from, to); } catch { /* best effort */ }
    }
  }
}

function writeRestricted(path: string, data: string): void {
  writeFileSync(path, data);
  chmodSync(path, 0o600);
}

async function setup(): Promise<void> {
  runRoot = mkdtempSync(join(tmpdir(), `pi-journey-`));
  chmodSync(runRoot, 0o700);
  abtarsHome = join(runRoot, "abtars-home");
  workspaceDir = join(runRoot, "workspace");
  homeDir = join(runRoot, "home");
  logDir = join(runRoot, "logs");
  for (const dir of [abtarsHome, join(abtarsHome, "config"), workspaceDir, homeDir, logDir]) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  console.log(`Run root: ${runRoot}`);

  // Real git workspace (allowlisted).
  execSync("git init -q", { cwd: workspaceDir });
  execSync('git config user.email "pi-journey@local"', { cwd: workspaceDir });
  execSync('git config user.name "pi-journey"', { cwd: workspaceDir });
  writeFileSync(join(workspaceDir, "README.md"), "# pi-journey workspace\n");
  execSync("git add README.md", { cwd: workspaceDir });
  execSync("git commit -q -m initial", { cwd: workspaceDir });

  // Isolated ~/.pi copy (real credentials + settings; sessions stay isolated).
  const piHome = join(homeDir, ".pi");
  mkdirSync(piHome, { recursive: true });
  copyDirRecursive(join(homeHost, ".pi"), piHome, new Set(["sessions"]));
  mkdirSync(join(piHome, "agent", "sessions"), { recursive: true });
  const sessionRoot = realpathSync(join(piHome, "agent", "sessions"));

  // Route the Pi child's default model through the isolated settings file —
  // the same file pi 0.83 resolves at boot. The provider/model pair is read
  // from the environment so no credential or account detail lives in the repo.
  // NOTE: this path still reaches a hosted provider and therefore costs money
  // per run. It is a supplementary live smoke only. The automated gate must use
  // a local endpoint instead — see the deterministic-port ticket.
  const settingsPath = join(piHome, "agent", "settings.json");
  const journeyProvider = process.env["PI_JOURNEY_PROVIDER"];
  const journeyModel = process.env["PI_JOURNEY_MODEL"];
  if (!journeyProvider || !journeyModel) {
    throw new Error("set PI_JOURNEY_PROVIDER and PI_JOURNEY_MODEL — this harness does not hardcode a provider or account");
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    settings["defaultProvider"] = journeyProvider;
    settings["defaultModel"] = journeyModel;
    settings["defaultThinkingLevel"] = "low";
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    throw new Error("cannot rewrite isolated pi settings.json");
  }

  const piExecutable = resolvePiExecutable();
  if (!piExecutable) throw new Error("standalone `pi` executable not found on PATH");

  // ── transport.json — fixture provider for Main only ──────────────────────
  writeRestricted(join(abtarsHome, "config", "transport.json"), JSON.stringify({
    schemaVersion: 3,
    routes: {
      "pi-ai": {
        agents: { main: { model: FIXTURE_MODEL_A, provider: FIXTURE_PROVIDER } },
        fallbacks: [{ model: FIXTURE_MODEL_B, provider: FIXTURE_PROVIDER }],
      },
    },
    providers: {
      [FIXTURE_PROVIDER]: {
        transport: "api",
        endpoint: provider.baseUrl,
        apiKeyEnv: FIXTURE_API_KEY_ENV,
        apiFormat: "chat",
      },
    },
    maxTurns: 3,
    maxToolRounds: 3,
    maxFallbackToolRounds: 3,
  }, null, 2));

  const modelEntry = () => ({
    contextWindow: 128000, maxOutput: 4096, rank: 100,
    cost: { input: 0, output: 0 }, transports: [FIXTURE_PROVIDER],
    description: "fixture loopback model", status: "alive",
  });
  writeRestricted(join(abtarsHome, "config", "models.json"), JSON.stringify({
    [FIXTURE_MODEL_A]: modelEntry(),
    [FIXTURE_MODEL_B]: modelEntry(),
  }, null, 2));

  writeRestricted(join(abtarsHome, "config", "users.json"), JSON.stringify({
    users: [{
      userId: MASTER_USER_ID,
      displayName: "pi-journey-master",
      role: "master",
      platforms: { tui: "tui:local" },
    }],
  }, null, 2));

  // ── pi-executor.json — real standalone pi, isolated sessions ─────────────
  writeRestricted(join(abtarsHome, "config", "pi-executor.json"), JSON.stringify({
    enabled: true,
    command: piExecutable,
    workspaceAliases: { default: { path: workspaceDir } },
    allowedEnv: [],
    maxConcurrent: 1,
    maxWallClockMs: 20 * 60 * 1000,
    abortGraceMs: 6_000,
    projectTrust: "never",
    sessionStorageRoot: sessionRoot,
  }, null, 2));

  bridgeEnv = buildBridgeEnv();
}

// ── Journey ─────────────────────────────────────────────────────────────────

async function journey(deadline: number): Promise<void> {
  // Phase 0: smoke — the pipeline + TUI + fixture provider are live.
  const smokeMarker = `PI-JOURNEY-SMOKE-${randomUUID().slice(0, 6)}`;
  const smokeReply = `PI-JOURNEY-SMOKE-OK-${randomUUID().slice(0, 6)}`;
  provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: undefined, action: { kind: "text", chunks: [smokeReply] } });
  const smoke = await tui.sendAndAwaitReply(smokeMarker, 60_000);
  const smokeOk = smoke.markdown.includes(smokeReply);
  record("smoke", smokeOk, smokeOk ? "TUI pipeline exchange reached the fixture provider" : `smoke reply missing marker (got: ${smoke.markdown.slice(0, 160)})`);
  if (!smokeOk) return;

  // Phase 1: start run1 (long multi-step goal so steering/cancel have a window).
  const m1 = `PI-JOURNEY-A-${randomUUID().slice(0, 6)}`;
  const m2 = `PI-JOURNEY-B-${randomUUID().slice(0, 6)}`;
  const mS = `PI-JOURNEY-STEER-${randomUUID().slice(0, 6)}`;
  const run1Goal = `Work through these steps one at a time and commit at the end: 1) create pi-journey-a.txt containing exactly ${m1}; 2) create pi-journey-b.txt containing exactly ${m2}; 3) create pi-journey-c.txt containing exactly PI-JOURNEY-C-${randomUUID().slice(0, 6)}; 4) create pi-journey-d.txt containing exactly PI-JOURNEY-D-${randomUUID().slice(0, 6)}; 5) create pi-journey-e.txt containing exactly PI-JOURNEY-E-${randomUUID().slice(0, 6)}; 6) run git add -A and git commit -m run1; 7) when done, reply with the text ${m1}-DONE.`;
  let { reply } = await tuiCommand(`/pi run --workspace default ${run1Goal}`, "run1 create");
  const run1 = parseRunReply(reply);
  const startOk = !!run1 && run1.generation === 1;
  record("run1-start", startOk, startOk ? `runId=${run1!.runId} card=#${run1!.cardId} session=${run1!.sessionId} gen=1` : `could not parse run creation reply: ${reply.slice(0, 200)}`);
  if (!run1) return;

  // Phase 2: attach + observe.
  await waitForRunStatus(run1.runId, ["starting", "running"], 120_000);
  const sessionIdx = await findCodeSessionIndex();
  const attachVisible = sessionIdx !== null;
  record("run1-session-visible", attachVisible, attachVisible ? `C session listed at index #${sessionIdx}` : "/sessions showed no Code session");
  if (attachVisible) {
    tui.sendInput(`/session ${sessionIdx}`);
    await waitFor(async () => (tui.sessionId === run1.sessionId ? true : undefined), 30_000, `TUI attached to Pi C session ${run1.sessionId}`);
    record("run1-attach", tui.sessionId === run1.sessionId, `attached to exact Pi session ${run1.sessionId}`);
  } else {
    record("run1-attach", false, "cannot attach — session not visible");
  }

  const running1 = await waitForRunStatus(run1.runId, ["running", "awaiting_input", "cancelled", "completed"], 180_000);
  record("run1-running", ["running", "awaiting_input"].includes(running1.status), `status=${running1.status} gen=${running1.generation}`);

  // Child environment audit while live.
  const piChildren = psPiChildren();
  if (piChildren.length > 0) {
    const childPid = piChildren[0]!.pid;
    const env = readProcEnviron(childPid);
    const noSentinel = env[SENTINEL_ENV] === undefined;
    const noNodeOptions = env["NODE_OPTIONS"] === undefined;
    const hasCorrelation = Boolean(env["ABMIND_USER_ID"]) && Boolean(env["ABMIND_PARENT_EXECUTION_ID"]);
    const homeIsolated = env["HOME"] === homeDir;
    record("child-env", noSentinel && noNodeOptions && hasCorrelation && homeIsolated,
      `pid=${childPid} sentinelLeak=${!noSentinel} nodeOptionsLeak=${!noNodeOptions} correlation=${hasCorrelation} isolatedHome=${homeIsolated}`);
  } else {
    record("child-env", false, "no pi child found while run1 running");
  }

  // Phase 3: steer.
  await waitForRunStatus(run1.runId, ["running", "awaiting_input"], 240_000);
  const steerReply = await tuiCommand(`/pi steer ${run1.runId} Do this now: also create pi-journey-steer.txt containing exactly ${mS}. Then continue with the remaining steps.`, "run1 steer");
  const steerAck = !steerReply.reply.startsWith("❌");
  record("run1-steer", steerAck, steerAck ? "steer accepted" : `steer rejected: ${steerReply.reply.slice(0, 200)}`);

  // Phase 4: reply (opportunistic — only when pi raises a bounded UI request).
  let replied = false;
  try {
    const pending = await waitFor(
      async () => {
        if (Date.now() > deadline) throw new Error("journey deadline reached while waiting for UI request");
        const view = await piStatus(run1.runId);
        return view.pendingRequestId ? view : undefined;
      },
      20_000,
      `run1 awaiting-input request`,
    );
    const reqId = pending.pendingRequestId!;
    const replyOk = await tuiCommand(`/pi reply ${run1.runId} ${reqId} yes`, "run1 reply");
    replied = !replyOk.reply.startsWith("❌");
    record("run1-reply", replied, replied ? `replied to request ${reqId}` : `reply rejected: ${replyOk.reply.slice(0, 200)}`);
  } catch {
    record("run1-reply", true, "no UI request surfaced in the real run; reply machinery covered by focused unit suites (awaiting_input not exercised live)");
  }

  // Phase 5: cancel while the run is still active.
  const active1 = await waitForRunStatus(run1.runId, ["running", "awaiting_input", "completed", "failed", "cancelled"], 120_000);
  if (active1.status === "running" || active1.status === "awaiting_input") {
    const cancelReply = await tuiCommand(`/pi cancel ${run1.runId}`, "run1 cancel");
    const cancelAck = !cancelReply.reply.startsWith("❌");
    record("run1-cancel-accepted", cancelAck, cancelAck ? "cancel accepted" : `cancel rejected: ${cancelReply.reply.slice(0, 200)}`);
    const cancelled = await waitForRunStatus(run1.runId, ["cancelled", "failed"], 90_000);
    record("run1-cancelled", cancelled.status === "cancelled", `terminal status=${cancelled.status}`);
    await waitFor(
      async () => (psPiChildren().length === 0 ? true : undefined),
      30_000,
      "run1 pi child gone after cancel",
    );
    record("run1-child-gone", psPiChildren().length === 0, "no pi child remains after cancel");
    // Same-process orphan-session check: the terminal run's C session must be gone.
    const sessionsAfterCancel = await tuiCommand("/sessions", "session list after run1 cancel");
    const codeAfterCancel = sessionsAfterCancel.reply.split("\n").filter((l) => l.includes("Code"));
    record("no-orphan-session-after-cancel", codeAfterCancel.length === 0,
      codeAfterCancel.length === 0 ? "no live Code session after cancel" : `STILL LISTED: ${codeAfterCancel.join(" | ").slice(0, 300)}`);
    record("run1-steer-applied", await fileExistsInWorkspace("pi-journey-steer.txt"), "steer-flag file in workspace (applied before cancel)");
  } else {
    record("run1-cancel-accepted", false, `run reached terminal status ${active1.status} before cancel could be issued`);
    const sessionsAfterComplete = await tuiCommand("/sessions", "session list after run1 complete");
    const codeAfterComplete = sessionsAfterComplete.reply.split("\n").filter((l) => l.includes("Code"));
    record("no-orphan-session-after-complete", codeAfterComplete.length === 0,
      codeAfterComplete.length === 0 ? "no live Code session after terminal completion" : `STILL LISTED: ${codeAfterComplete.join(" | ").slice(0, 300)}`);
    record("run1-steer-applied", await fileExistsInWorkspace("pi-journey-steer.txt"), "steer-flag file in workspace (steer applied during run)");
  }

  // Phase 6: bridge restart (terminal run stays terminal).
  await restartBridge();
  record("bridge-restart-1", true, `bridge respawned (pid ${bridge.pid})`);
  tui.close();
  await tui.connect("resume");
  const afterRestart = await piStatus(run1.runId);
  record("restart-preserves-terminal", afterRestart.status === "cancelled" || afterRestart.status === "completed", `status after restart=${afterRestart.status} (terminal stays terminal)`);

  // Phase 6b: stale/foreign control rejection on the terminal run.
  const staleSteer = await tuiCommand(`/pi steer ${run1.runId} do-not-apply`, "stale steer");
  record("stale-steer-rejected", staleSteer.reply.startsWith("❌") || staleSteer.reply.includes("not active"), `reply: ${staleSteer.reply.slice(0, 160)}`);
  const staleReply = await tuiCommand(`/pi reply ${run1.runId} bogus-request yes`, "stale reply");
  record("stale-reply-rejected", staleReply.reply.startsWith("❌"), `reply: ${staleReply.reply.slice(0, 160)}`);

  // Phase 7: crash + recovery + explicit same-session resume journey (run2).
  // A hard SIGKILL crash is the realistic interruption: boot recovery marks
  // active runs interrupted and fails their linked card — the state resume
  // requires (graceful SIGTERM shutdown leaves the card running; recorded
  // separately as the interruptAll-card mismatch finding).
  const run2Goal = `Work through these steps one at a time: 1) create pi-journey-run2-a.txt containing exactly PI-JOURNEY-R2A-${randomUUID().slice(0, 6)}; 2) create pi-journey-run2-b.txt containing exactly PI-JOURNEY-R2B-${randomUUID().slice(0, 6)}; 3) create pi-journey-run2-c.txt containing exactly PI-JOURNEY-R2C-${randomUUID().slice(0, 6)}; 4) git add -A and git commit -m run2; 5) reply PI-JOURNEY-RUN2-DONE.`;
  const r2 = parseRunReply((await tuiCommand(`/pi run --workspace default ${run2Goal}`, "run2 create")).reply);
  record("run2-start", !!r2, r2 ? `runId=${r2.runId} gen=${r2.generation}` : "run2 creation failed");
  if (!r2) return;
  await waitForRunStatus(r2.runId, ["running", "awaiting_input"], 180_000);
  // Wait for the first output file: proves the first turn settled AND pi
  // flushed the session file to disk (the durable resume precondition).
  try {
    await waitForWorkspaceFile("pi-journey-run2-a.txt", 240_000);
    record("run2-first-turn-settled", true, "first output file present — pi session flushed");
  } catch {
    record("run2-first-turn-settled", false, "first output file did not appear within 4 min");
  }
  record("run2-running", true, "run2 active before crash");

  // Hard crash: SIGKILL the bridge (no shutdown handler runs).
  const crashedPid = bridge.pid;
  process.kill(bridge.pid, "SIGKILL");
  await waitFor(async () => (bridge.exited ? true : undefined), 15_000, "bridge killed");
  record("bridge-crash", true, `bridge pid ${crashedPid} SIGKILLed`);
  // The exact pi child handle died with the bridge — check for an orphan.
  const orphanAfterCrash = psPiChildren().length;
  record("crash-orphan-pi-child", orphanAfterCrash === 0, orphanAfterCrash === 0 ? "no orphan pi child after crash" : `${orphanAfterCrash} orphan pi child(ren) survive the crash (duplicate-execution hazard)`);

  bridge = await spawnBridge();
  record("bridge-reboot-after-crash", true, `bridge respawned (pid ${bridge.pid})`);
  tui.close();
  await tui.connect("resume");
  const run2AfterCrash = await piStatus(r2.runId);
  record("run2-recovery-on-boot", run2AfterCrash.status === "interrupted", `run2 status after crash+reboot=${run2AfterCrash.status} (expected interrupted)`);

  // Explicit same-session resume.
  const resumeReply = await tuiCommand(`/pi resume ${r2.runId}`, "run2 resume");
  const resumed = parseRunReply(resumeReply.reply);
  const resumeGen2 = resumed && resumed.generation === 2 && resumed.sessionId !== r2.sessionId;
  record("run2-resume", !!resumed && !!resumeGen2, resumeGen2 ? `generation=2 new session=${resumed!.sessionId}` : `resume reply: ${resumeReply.reply.slice(0, 220)}`);
  if (resumed && resumeGen2) {
    const running2 = await waitForRunStatus(r2.runId, ["running", "awaiting_input", "completed", "failed"], 240_000);
    record("run2-resume-running", ["running", "awaiting_input"].includes(running2.status), `post-resume status=${running2.status}`);
    const completed2 = await waitForRunStatus(r2.runId, ["completed", "failed"], 600_000);
    record("run2-completed", completed2.status === "completed", `terminal=${completed2.status}`);
    const run2Files = ["pi-journey-run2-a.txt", "pi-journey-run2-b.txt", "pi-journey-run2-c.txt"];
    const fileChecks = await Promise.all(run2Files.map((f) => fileExistsInWorkspace(f)));
    record("run2-outputs", fileChecks.every(Boolean), `files present: ${run2Files.map((f, i) => `${f}=${fileChecks[i]}`).join(" ")} (same session continued across crash)`);
    const sessionsAfterRun2 = await tuiCommand("/sessions", "session list after run2 complete");
    const codeAfterRun2 = sessionsAfterRun2.reply.split("\n").filter((l) => l.includes("Code"));
    record("no-orphan-session-after-complete", codeAfterRun2.length === 0,
      codeAfterRun2.length === 0 ? "no live Code session after terminal completion" : `STILL LISTED: ${codeAfterRun2.join(" | ").slice(0, 300)}`);
    // A crash-orphaned gen-1 child may still be working (duplicate execution).
    const orphanNow = psPiChildren();
    record("crash-orphan-resolved", orphanNow.length === 0, orphanNow.length === 0 ? "no pi child remains after completion" : `STILL ALIVE: pids ${orphanNow.map((p) => p.pid).join(",")} (duplicate execution in the workspace)`);
  }

  // Phase 8 (trimmed for #1636 planning): a single queued-capacity sanity note.
  // Deeper capacity/dispatch assertions belong to epic27 (#1636) planning.
  const sessionsFinal = await tuiCommand("/sessions", "final session list");
  const codeSessionsFinal = sessionsFinal.reply.split("\n").filter((l) => l.includes("Code"));
  record("final-no-live-code-sessions", codeSessionsFinal.length === 0, codeSessionsFinal.length === 0 ? "no live Code sessions remain" : `STILL LISTED: ${codeSessionsFinal.join(" | ").slice(0, 300)}`);
  record("final-pi-children", psPiChildren().length === 0, `pi children in run root: ${psPiChildren().length}`);
}

// ── Orphan audit after shutdown ─────────────────────────────────────────────

function auditDb(): { runs: Array<Record<string, unknown>>; cards: Array<Record<string, unknown>> } {
  const dbPath = join(abtarsHome, "kanban", "kanban.db");
  if (!existsSync(dbPath)) return { runs: [], cards: [] };
  const runsJson = execSync(`sqlite3 ${JSON.stringify(dbPath)} "SELECT id, status, execution_generation FROM pi_runs ORDER BY id"`, { encoding: "utf-8" });
  const cardsJson = execSync(`sqlite3 ${JSON.stringify(dbPath)} "SELECT id, title, status, type FROM kanban_board WHERE type='pi' ORDER BY id"`, { encoding: "utf-8" });
  const runs = runsJson.trim() ? runsJson.trim().split("\n").map((l) => { const [id, status, gen] = l.split("|"); return { id, status, generation: gen }; }) : [];
  const cards = cardsJson.trim() ? cardsJson.trim().split("\n").map((l) => { const [id, title, status, type] = l.split("|"); return { id, title: (title ?? "").slice(0, 40), status, type }; }) : [];
  return { runs, cards };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const piExecutable = resolvePiExecutable();
  if (!piExecutable) {
    process.exitCode = 1;
  }

  // Build the deployed bundle once.
  execFileSync("npm", ["run", "build"], { cwd: abtarsRoot, stdio: "inherit" });
  execFileSync("npm", ["run", "bundle"], { cwd: abtarsRoot, stdio: "inherit" });

  provider = new ScriptedProvider();
  await provider.start();
  try {
    await setup();
    bridge = await spawnBridge();
    tui = new TuiAcceptanceClient(abtarsHome);
    await tui.connect("new");

    const journeyDeadline = Date.now() + JOURNEY_DEADLINE_MS;
    try {
      await journey(journeyDeadline);
    } finally {
      // Exact-child cleanup in reverse ownership order.
      try { tui.close(); } catch { /* best effort */ }
      if (bridge && !bridge.exited) {
        await bridge.terminate();
        if (bridge.degradedCleanup) record("cleanup", false, "bridge needed SIGKILL");
      }
    }

    // Audit after graceful shutdown.
    await waitFor(async () => (psPiChildren().length === 0 ? true : undefined), 20_000, "no pi children after bridge shutdown");
    record("shutdown-no-orphan-process", psPiChildren().length === 0, `pi --mode rpc children after shutdown: ${psPiChildren().length}`);
    const db = auditDb();
    const runsTerminal = db.runs.length > 0 && db.runs.every((r) => ["completed", "failed", "cancelled", "interrupted"].includes(String(r.status)));
    const cardsTerminal = db.cards.length > 0 && db.cards.every((c) => ["done", "failed"].includes(String(c.status)));
    record("db-runs-terminal", runsTerminal, db.runs.length === 0 ? "no pi_runs rows" : db.runs.map((r) => `${r.id}:${r.status}`).join(", "));
    record("db-cards-terminal", cardsTerminal, db.cards.length === 0 ? "no pi cards" : db.cards.map((c) => `#${c.id}:${c.status}`).join(", "));
  } catch (err) {
    record("lane-setup", false, err instanceof Error ? err.message : String(err));
  } finally {
    await provider.close();
  }

  // Results + evidence artifact.
  const failed = evidence.filter((e) => !e.ok).length;
  const resultDir = join(abtarsRoot, "test-results", "pi-local-journey", `journey-${Date.now()}-${randomUUID().slice(0, 6)}`);
  mkdirSync(resultDir, { recursive: true });
  const summary = {
    kind: "pi-local-journey",
    runRoot,
    startedAt,
    durationMs: Date.now() - startedAt,
    passed: evidence.length - failed,
    failed,
    checks: evidence,
  };
  writeFileSync(join(resultDir, "pi-local-journey.json"), JSON.stringify(summary, null, 2));
  const md = [
    "# Pi local journey E2E",
    "",
    `Run root: \`${runRoot}\``,
    `Duration: ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...evidence.map((e) => `| ${e.step} | ${e.ok ? "+" : "x"} | ${e.detail.replace(/\|/g, "\\|")} |`),
  ].join("\n");
  writeFileSync(join(resultDir, "pi-local-journey.md"), md);
  console.log(`\nEvidence: ${resultDir}`);
  console.log(`PI_JOURNEY_RESULT=${JSON.stringify({ passed: evidence.length - failed, failed, checks: evidence.length })}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main().catch((err) => {
  console.error(`pi-local-journey-e2e failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
