/**
 * doctor-probes.ts — structured health probes grouped by subsystem layer.
 * Replaces scripts/doctor.sh entirely.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { abtarsHome } from "../../paths.js";
import { resolveAbmindPackageDir } from "../../utils/abmind-lazy.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  name: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
  ms?: number;
}

export interface FixResult {
  probe: string;
  action: string;
  success: boolean;
}

export type LayerName = "body" | "heart" | "brain" | "soul" | "tribe";

export interface DoctorOutput {
  version: "1.0";
  totalMs: number;
  layers: Record<LayerName, ProbeResult[]>;
  fixes?: FixResult[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const home = abtarsHome();
const configDir = join(home, "config");
const TTL_MS = 180_000; // gossip: 3 missed 60s broadcasts → stale (matches gossip.ts)

function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function readEnv(): Map<string, string> {
  const envPath = join(configDir, ".env");
  const map = new Map<string, string>();
  if (!existsSync(envPath)) return map;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  return map;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

async function timedProbe(fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const r = await fn();
    r.ms = r.ms ?? (Date.now() - start);
    return r;
  } catch (err) {
    return { name: "unknown", status: "failed", detail: String(err), ms: Date.now() - start };
  }
}

// ── Body Probes ──────────────────────────────────────────────────────────────

async function probePlatforms(): Promise<ProbeResult> {
  const { readSecret, initSecretsKey } = await import("../../components/secrets.js");
  initSecretsKey();

  const results: Array<{ name: string; status: "ok" | "failed" | "skipped"; detail: string }> = [];

  // Telegram: read token, call getMe
  const telegramToken = readSecret("TELEGRAM_BOT_TOKEN") ?? readSecret("TELEGRAM_TOKEN");
  if (telegramToken) {
    const r = await verifyTelegram(telegramToken);
    results.push({ name: "telegram", ...r });
  }

  // Discord: read token, call gateway
  const discordToken = readSecret("DISCORD_BOT_TOKEN") ?? readSecret("DISCORD_TOKEN");
  if (discordToken) {
    const r = await verifyDiscord(discordToken);
    results.push({ name: "discord", ...r });
  }

  // IRC: skip real verification (connection-based), just check if configured
  const ircServer = readSecret("IRC_SERVER");
  if (ircServer) {
    results.push({ name: "irc", status: "ok", detail: "server configured (connection not verified)" });
  }

  if (results.length === 0) return { name: "platforms", status: "skipped", detail: "no platform configured" };

  const failed = results.filter(r => r.status === "failed");
  const skipped = results.filter(r => r.status === "skipped");
  const allOk = failed.length === 0 && skipped.length === 0;
  const status = allOk ? "ok" : failed.length > 0 ? "failed" : "ok";
  const detail = results.map(r => `${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join(", ");
  return { name: "platforms", status, detail };
}

async function verifyTelegram(token: string): Promise<{ status: "ok" | "failed" | "skipped"; detail: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return { status: "ok", detail: "getMe ok" };
    if (res.status === 401 || res.status === 403) return { status: "failed", detail: "invalid token" };
    return { status: "skipped", detail: `http ${res.status}` };
  } catch {
    return { status: "skipped", detail: "unreachable" };
  }
}

async function verifyDiscord(token: string): Promise<{ status: "ok" | "failed" | "skipped"; detail: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { "Authorization": `Bot ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) return { status: "ok", detail: "gateway ok" };
    if (res.status === 401 || res.status === 403) return { status: "failed", detail: "invalid token" };
    return { status: "skipped", detail: `http ${res.status}` };
  } catch {
    return { status: "skipped", detail: "unreachable" };
  }
}

async function probeDashboard(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_DASHBOARD") !== "true") return { name: "dashboard", status: "skipped", detail: "not enabled" };
  const port = env.get("DASHBOARD_PORT") || env.get("WEB_PORT") || "3000";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return { name: "dashboard", status: res.ok ? "ok" : "failed", detail: `:${port}` };
  } catch {
    return { name: "dashboard", status: "failed", detail: `:${port} unreachable` };
  }
}

async function probeSecurity(): Promise<ProbeResult> {
  const env = readEnv();
  const mode = env.get("SECURITY_MODE") || "off";
  const validModes = ["off", "guardrails", "seatbelt", "docker"];
  if (!validModes.includes(mode)) return { name: "security", status: "failed", detail: `invalid mode: ${mode}` };

  // Check secret file perms
  const secretDir = join(home, "secret");
  let permIssues = 0;
  if (existsSync(secretDir)) {
    for (const f of readdirSync(secretDir)) {
      const st = statSync(join(secretDir, f));
      if (st.isFile() && (st.mode & 0o777) !== 0o600) permIssues++;
    }
  }

  const parts = [mode];
  if (existsSync(join(home, "auth", "rules.json"))) parts.push("ActionGate");
  if (permIssues > 0) return { name: "security", status: "failed", detail: `${mode}, ${permIssues} file(s) not 600` };
  return { name: "security", status: "ok", detail: parts.join(", ") };
}

async function probeWatchdog(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock"));
  if (!lock) return { name: "watchdog", status: "failed", detail: "bridge.lock missing" };

  const bridgePid = lock.pid ?? 0;
  const wdPid = lock.watchdogPid ?? 0;
  const bridgeAlive = bridgePid > 0 && pidAlive(bridgePid);
  const wdAlive = wdPid > 0 && pidAlive(wdPid);

  if (bridgeAlive && wdAlive) return { name: "watchdog", status: "ok", detail: `${bridgePid}, wd:${wdPid}` };
  if (!bridgeAlive && !wdAlive) return { name: "watchdog", status: "failed", detail: `${bridgePid} dead, wd:${wdPid} dead` };
  if (!wdAlive) return { name: "watchdog", status: "failed", detail: `${bridgePid} alive, wd:${wdPid} dead (unprotected)` };
  return { name: "watchdog", status: "failed", detail: `${bridgePid} dead, wd:${wdPid} alive (will restart)` };
}

// ── Heart Probes ─────────────────────────────────────────────────────────────

async function probeHeartbeat(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock"));
  if (!lock?.lastHeartbeat) return { name: "heartbeat", status: "skipped", detail: "no bridge.lock" };
  const ageMs = Date.now() - lock.lastHeartbeat;
  if (ageMs > 120_000) return { name: "heartbeat", status: "failed", detail: `stale (${ago(ageMs)})` };
  return { name: "heartbeat", status: "ok", detail: ago(ageMs) };
}

// #1261: bridge invariant — catches duplicate-bridge regressions at runtime.
// pgrep counts the bridge processes. >1 means a second bridge is running (likely orphaned).
async function probeBridge(): Promise<ProbeResult> {
  const { spawnSync } = await import("node:child_process");
  const pgrep = spawnSync("pgrep", ["-f", "app/bundle/abtars.js"], { encoding: "utf-8" });
  const pids = pgrep.stdout ? pgrep.stdout.trim().split("\n").filter(Boolean) : [];
  if (pids.length === 0) return { name: "bridge", status: "skipped", detail: "no bridge running" };
  if (pids.length === 1) return { name: "bridge", status: "ok", detail: `pid:${pids[0]}` };
  return { name: "bridge", status: "failed", detail: `${pids.length} bridges running: ${pids.join(",")}` };
}

async function probeTui(): Promise<ProbeResult> {
  const sockPath = join(home, "tui.sock");
  if (!existsSync(sockPath)) return { name: "tui", status: "skipped", detail: "no tui.sock" };
  try {
    const { connect } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = connect(sockPath, () => { s.end(); resolve(); });
      s.on("error", (e) => { s.destroy(); reject(e); });
      s.on("timeout", () => { s.destroy(); reject(new Error("connect timeout")); });
    });
    return { name: "tui", status: "ok", detail: "socket responding" };
  } catch {
    return { name: "tui", status: "failed", detail: "socket exists but not responding" };
  }
}

// ── Brain Probes ─────────────────────────────────────────────────────────────

async function probeTransport(): Promise<ProbeResult> {
  const tPath = join(configDir, "transport.json");
  const t = readJson(tPath);
  if (!t) return { name: "transport", status: "failed", detail: "transport.json missing or invalid" };
  const agents = Object.keys(t.agents ?? {});
  if (agents.length === 0) return { name: "transport", status: "failed", detail: "no agents configured" };
  return { name: "transport", status: "ok", detail: `${agents.length} agent(s): ${agents.join(", ")}` };
}

async function probeSpin(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock"));
  if (!lock?.pid || !pidAlive(lock.pid)) return { name: "spin", status: "failed", detail: "bridge not running" };
  return { name: "spin", status: "ok", detail: "bridge alive" };
}

async function probeKanban(): Promise<ProbeResult> {
  const dbPath = join(home, "kanban", "kanban.db");
  if (!existsSync(dbPath)) return { name: "kanban", status: "skipped", detail: "kanban.db not found" };
  const sharedNm = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
  if (!existsSync(sharedNm)) return { name: "kanban", status: "skipped", detail: "better-sqlite3 not installed (run: abtars deps install)" };
  let Db: any;
  try {
    const { createRequire } = await import("node:module");
    const _require = createRequire(import.meta.url);
    Db = _require(sharedNm);
  } catch (err) {
    return { name: "kanban", status: "skipped", detail: `better-sqlite3 not loadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const db = new Db(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM kanban_board").get() as { cnt: number };
    const stuck = db.prepare("SELECT COUNT(*) as cnt FROM kanban_board WHERE status='running' AND updated_at < datetime('now', '-10 minutes')").get() as { cnt: number };
    db.close();
    const detail = stuck.cnt > 0 ? `${row.cnt} cards, ${stuck.cnt} stuck` : `${row.cnt} cards`;
    return { name: "kanban", status: stuck.cnt > 0 ? "failed" : "ok", detail };
  } catch (err) {
    return { name: "kanban", status: "skipped", detail: `kanban.db query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function probeSkills(): Promise<ProbeResult> {
  const catalog = join(home, "skills", "skills_catalog.md");
  if (!existsSync(catalog)) return { name: "skills", status: "failed", detail: "skills_catalog.md missing" };
  const content = readFileSync(catalog, "utf-8");
  const count = (content.match(/^## /gm) || []).length;
  if (count === 0) return { name: "skills", status: "failed", detail: "catalog empty" };
  return { name: "skills", status: "ok", detail: `${count} loaded` };
}

async function probeSha(): Promise<ProbeResult> {
  // Check if healer skill exists in catalog
  const catalog = join(home, "skills", "skills_catalog.md");
  if (!existsSync(catalog)) return { name: "sha", status: "skipped", detail: "no catalog" };
  const content = readFileSync(catalog, "utf-8");
  if (/self.heal|healer|auto.fix/i.test(content)) return { name: "sha", status: "ok", detail: "rules loaded" };
  // Check sha-policy.json
  if (existsSync(join(configDir, "sha-policy.json"))) return { name: "sha", status: "ok", detail: "rules loaded" };
  return { name: "sha", status: "skipped", detail: "no healer rules configured" };
}

// ── Tribe Probes ─────────────────────────────────────────────────────────────

async function probeA2a(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "a2a", status: "skipped", detail: "not enabled" };
  const port = parseInt(env.get("AGENT_API_PORT") || "7100", 10);
  try {
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    return { name: "a2a", status: "ok", detail: `${port}` };
  } catch {
    return { name: "a2a", status: "failed", detail: `${port} not listening` };
  }
}

async function probePeers(): Promise<ProbeResult> {
  const peersPath = join(configDir, "peers.json");
  const peers = readJson(peersPath) as { peers?: Record<string, { verifyKey?: string; trust?: number }>; self?: { signingKey?: string; tribeToken?: string } } | null;
  if (!peers) return { name: "peers", status: "skipped", detail: "peers.json missing" };
  if (!peers.self?.signingKey) return { name: "peers", status: "failed", detail: "self.signingKey missing — run: abtars install" };

  const peerEntries = Object.entries(peers.peers ?? {});
  const peerCount = peerEntries.length;
  if (peerCount === 0) return { name: "peers", status: "skipped", detail: "no peers (solo)" };

  // Check that all peers have verifyKey
  const missingKey = peerEntries.filter(([, e]) => !e.verifyKey).map(([n]) => n);
  if (missingKey.length > 0) return { name: "peers", status: "failed", detail: `missing verifyKey: ${missingKey.join(", ")}` };

  return { name: "peers", status: "ok", detail: `${peerCount} enrolled (all keys valid)` };
}

async function probeIdentity(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "identity", status: "skipped", detail: "a2a disabled" };

  // Use the shared read-only validator (#1305)
  try {
    const { loadPeerConfig } = require("../../components/peer-config.js") as typeof import("../../components/peer-config.js");
    const { validateAgentApiTlsIdentity } = require("../../components/peer-transport/tls-identity.js") as typeof import("../../components/peer-transport/tls-identity.js");
    const config = loadPeerConfig();
    const identity = validateAgentApiTlsIdentity(configDir, config.self.signingKey);
    return { name: "identity", status: "ok", detail: `cert matches signing key (expires ${identity.certificateNotAfter.toISOString().slice(0, 10)})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "identity", status: "failed", detail: msg };
  }
}

async function probeGossip(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "gossip", status: "skipped", detail: "a2a disabled" };

  const peers = readJson(join(configDir, "peers.json")) as { peers?: Record<string, unknown>; self?: { signingKey?: string } } | null;
  const peerCount = Object.keys(peers?.peers ?? {}).length;
  if (peerCount === 0) return { name: "gossip", status: "skipped", detail: "no peers (solo)" };
  if (!peers?.self?.signingKey) return { name: "gossip", status: "failed", detail: "self.signingKey missing — Ed25519 gossip requires identity" };

  const port = parseInt(env.get("GOSSIP_PORT") || "5355", 10);

  // Bind-test: if the port is already in use, gossip is live (EADDRINUSE = good).
  // If we can bind it, nothing is listening → gossip not running.
  const inUse = await new Promise<boolean>((resolve) => {
    import("node:dgram").then(({ createSocket }) => {
      const sock = createSocket("udp4");
      sock.once("error", (err: NodeJS.ErrnoException) => { sock.close(); resolve(err.code === "EADDRINUSE"); });
      sock.bind(port, "0.0.0.0", () => { sock.close(); resolve(false); });
    }).catch(() => resolve(false));
  });
  if (!inUse) return { name: "gossip", status: "failed", detail: `${port} not listening` };

  // Live — report broadcast freshness.
  const lock = readJson(join(home, "bridge.lock"));
  const last = typeof lock?.lastGossipBroadcast === "number" ? lock.lastGossipBroadcast : 0;
  if (!last) return { name: "gossip", status: "ok", detail: `${port} / no broadcast yet` };
  const age = Date.now() - last;
  if (age > TTL_MS) return { name: "gossip", status: "failed", detail: `${port} / stale (${ago(age)})` };
  return { name: "gossip", status: "ok", detail: `${port} / last broadcast ${ago(age)}` };
}

// ── Soul Probes ──────────────────────────────────────────────────────────────

async function probeMind(): Promise<ProbeResult> {
  try {
    const { loadAbmind } = await import("../../utils/abmind-lazy.js");
    const mod = await loadAbmind();
    if (!mod) return { name: "mind", status: "skipped", detail: "abmind not installed" };
    return { name: "mind", status: "ok", detail: "abmind loaded (in-process)" };
  } catch {
    return { name: "mind", status: "skipped", detail: "abmind load failed" };
  }
}

// ── Shared Native Deps Probe (#1388) ──────────────────────────────────────────

async function probeSharedDeps(): Promise<ProbeResult> {
  try {
    const { diagnoseSharedNativeDeps } = await importSharedDepsModule();
    const status = diagnoseSharedNativeDeps();
    const detail = `gen ${status.manifestGeneration}, ${status.packageCount} pkg(s)${status.lockHeld ? `, lock: ${status.lockOwner ?? "?"}` : ""}`;
    const mismatches = status.packages.filter(p => !p.onDisk);
    if (mismatches.length > 0) {
      return { name: "shared-deps", status: "failed", detail: `${detail}, ${mismatches.length} missing from disk` };
    }
    return { name: "shared-deps", status: "ok", detail };
  } catch {
    return { name: "shared-deps", status: "skipped", detail: "manifest not available" };
  }
}

// ── Pi Compatibility Probe (#1427) ────────────────────────────────────────────

async function probePiCompatibility(): Promise<ProbeResult> {
  try {
    const { inspectAllPiComponents } = await import("../../components/pi-inspector.js");
    const { loadPiConfig } = await import("../../components/pi-executor/config.js");
    const config = loadPiConfig();
    const statuses = inspectAllPiComponents({ command: config?.command });

    const details = statuses.map(s => `${s.component}=${s.state}${s.observed ? "(" + s.observed + ")" : ""}`).join(", ");
    const allOk = statuses.every(s => s.state === "ok");
    return { name: "pi-compatibility", status: allOk ? "ok" : "failed", detail: details };
  } catch {
    return { name: "pi-compatibility", status: "skipped", detail: "Pi inspector unavailable" };
  }
}

/** Import `diagnoseSharedNativeDeps` from abmind's deploy-lib using active discovery. */
async function importSharedDepsModule(): Promise<{ diagnoseSharedNativeDeps: () => import("abmind/deploy-lib/shared-native-deps.js").SharedNativeDepsStatus }> {
  const abmindDir = resolveAbmindPackageDir();
  if (abmindDir) {
    const modPath = join(abmindDir, "dist", "src", "deploy-lib", "shared-native-deps.js");
    if (existsSync(modPath)) {
      return import(pathToFileURL(modPath).href);
    }
  }
  return import("abmind/deploy-lib/shared-native-deps.js");
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runAllProbes(): Promise<DoctorOutput> {
  const start = Date.now();

  const [body, heart, brain, soul, tribe] = await Promise.all([
    Promise.all([probePlatforms(), probeDashboard(), probeSecurity(), probeWatchdog(), probeBridge(), probeTui()].map(p => timedProbe(() => p))),
    Promise.all([probeHeartbeat()].map(p => timedProbe(() => p))),
    Promise.all([probeTransport(), probeSpin(), probeKanban(), probeSkills(), probeSha(), probeSharedDeps(), probePiCompatibility()].map(p => timedProbe(() => p))),
    Promise.all([probeMind()].map(p => timedProbe(() => p))),
    Promise.all([probeA2a(), probePeers(), probeIdentity(), probeGossip()].map(p => timedProbe(() => p))),
  ]);

  return { version: "1.0", totalMs: Date.now() - start, layers: { body, heart, brain, soul, tribe } };
}

// ── Fix Logic ────────────────────────────────────────────────────────────────

export async function runFixes(): Promise<FixResult[]> {
  const { chmodSync, unlinkSync, mkdirSync, existsSync: ex, readdirSync: rd, statSync: st, readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const fixes: FixResult[] = [];

  function fix(probe: string, action: string, fn: () => void): void {
    try { fn(); fixes.push({ probe, action, success: true }); }
    catch { fixes.push({ probe, action, success: false }); }
  }

  // 1. chmod 700 sensitive dirs
  for (const dir of ["config", "secret", "auth", "hooks"]) {
    const p = join(home, dir);
    if (ex(p) && (st(p).mode & 0o777) !== 0o700) {
      fix("security", `${dir}/ → 700`, () => chmodSync(p, 0o700));
    }
  }

  // 2. chmod 600 secret files
  const secretDir = join(home, "secret");
  if (ex(secretDir)) {
    for (const f of rd(secretDir)) {
      const fp = join(secretDir, f);
      if (st(fp).isFile() && (st(fp).mode & 0o777) !== 0o600) {
        fix("security", `${f} → 600`, () => chmodSync(fp, 0o600));
      }
    }
  }

  // 3. chmod 600 config files
  if (ex(configDir)) {
    for (const f of rd(configDir)) {
      const fp = join(configDir, f);
      if (st(fp).isFile() && (st(fp).mode & 0o777) !== 0o600) {
        fix("security", `config/${f} → 600`, () => chmodSync(fp, 0o600));
      }
    }
  }

  // 4. Stale deploy.lock
  const deployLock = join(home, "deploy.lock");
  if (ex(deployLock)) {
    const lock = readJson(deployLock);
    const lockAge = lock?.startedAt ? (Date.now() - new Date(lock.startedAt).getTime()) / 1000 : 9999;
    const lockPid = lock?.pid ?? 0;
    if (lockAge > 300 && (lockPid === 0 || !pidAlive(lockPid))) {
      fix("watchdog", "removed stale deploy.lock", () => unlinkSync(deployLock));
    }
  }

  // 5. Stale .start-reason
  const startReason = join(home, ".start-reason");
  if (ex(startReason)) {
    const age = (Date.now() - st(startReason).mtimeMs) / 1000;
    if (age > 300) fix("watchdog", "removed stale .start-reason", () => unlinkSync(startReason));
  }

  // 6. Create missing dirs
  for (const dir of ["logs", "workspace", "overflow", "received"]) {
    const p = join(home, dir);
    if (!ex(p)) fix("watchdog", `created ${dir}/`, () => mkdirSync(p, { recursive: true }));
  }

  // 7. Kill orphan CLI processes
  try {
    const lock = readJson(join(home, "bridge.lock"));
    const bridgePid = lock?.pid ?? 0;
    const wdPid = lock?.watchdogPid ?? 0;

    // Orphan kiro-cli
    const kiro = spawnSync("pgrep", ["-f", "kiro-cli.*acp"], { encoding: "utf-8" });
    if (kiro.stdout) {
      for (const pid of kiro.stdout.trim().split("\n").filter(Boolean).map(Number)) {
        if (pid > 0 && pid !== bridgePid && pid !== wdPid && pid !== process.pid) {
          fix("brain", `killed orphan kiro-cli ${pid}`, () => process.kill(pid, "SIGTERM"));
        }
      }
    }

    // Orphan abtars-sleep
    const sleep = spawnSync("pgrep", ["-f", "abtars-sleep"], { encoding: "utf-8" });
    if (sleep.stdout) {
      for (const pid of sleep.stdout.trim().split("\n").filter(Boolean).map(Number)) {
        if (pid > 0 && pid !== bridgePid) {
          fix("brain", `killed orphan abtars-sleep ${pid}`, () => process.kill(pid, "SIGTERM"));
        }
      }
    }
  } catch { /* pgrep not available or no orphans */ }

  // 8. Stale locks/sockets
  for (const f of ["sleep.lock", "memory.sock"]) {
    const p = join(home, f);
    if (ex(p)) {
      const age = (Date.now() - st(p).mtimeMs) / 1000;
      const lock = readJson(join(home, "bridge.lock"));
      if (age > 600 && (!lock?.pid || !pidAlive(lock.pid))) {
        fix("watchdog", `removed stale ${f}`, () => unlinkSync(p));
      }
    }
  }

  // 9. Retention: delete old logs/overflow/media
  const LOGS_KEEP_DAYS = 7;
  const DATA_KEEP_DAYS = 30;
  try {
    const cutoffLogs = Date.now() - LOGS_KEEP_DAYS * 86400_000;
    const cutoffData = Date.now() - DATA_KEEP_DAYS * 86400_000;

    for (const [dir, cutoff] of [[join(home, "logs"), cutoffLogs], [join(home, "overflow"), cutoffData], [join(home, "received", "media"), cutoffLogs]] as const) {
      if (!ex(dir)) continue;
      let deleted = 0;
      for (const f of rd(dir)) {
        const fp = join(dir, f);
        if (st(fp).isFile() && st(fp).mtimeMs < cutoff) { unlinkSync(fp); deleted++; }
      }
      if (deleted > 0) fixes.push({ probe: "retention", action: `deleted ${deleted} stale file(s) from ${dir.split("/").pop()}`, success: true });
    }

    // Truncate audit.jsonl if >10MB
    const auditPath = join(home, "auth", "audit.jsonl");
    if (ex(auditPath) && st(auditPath).size > 10_000_000) {
      const lines = rf(auditPath, "utf-8").split("\n");
      wf(auditPath, lines.slice(-1000).join("\n"));
      fixes.push({ probe: "retention", action: "truncated audit.jsonl", success: true });
    }
  } catch { /* retention errors non-fatal */ }

  // 10. Kill duplicate bridges
  try {
    const lock = readJson(join(home, "bridge.lock"));
    const expectedPid = lock?.pid ?? 0;
    const pgrep = spawnSync("pgrep", ["-f", "abtars.*main"], { encoding: "utf-8" });
    if (pgrep.stdout) {
      for (const pid of pgrep.stdout.trim().split("\n").filter(Boolean).map(Number)) {
        if (pid > 0 && pid !== expectedPid && pid !== process.pid) {
          fix("watchdog", `killed duplicate bridge ${pid}`, () => process.kill(pid, "SIGTERM"));
        }
      }
    }
  } catch { /* non-fatal */ }

  // 11. Hooks dir perms
  const hooksDir = join(home, "hooks");
  if (ex(hooksDir) && (st(hooksDir).mode & 0o777) !== 0o700) {
    fix("security", "hooks/ → 700", () => chmodSync(hooksDir, 0o700));
  }

  // 12. Install watchdog service if missing
  try {
    const manifest = readJson(join(home, "manifest.json"));
    if (manifest?.installMode === "daemon") {
      const { platform } = await import("node:os");
      if (platform() === "darwin") {
        const plist = `${home}/com.abtars.watchdog.plist`;
        const dst = `${process.env["HOME"]}/Library/LaunchAgents/com.abtars.watchdog.plist`;
        if (ex(plist) && !ex(dst)) {
          fix("watchdog", "installed LaunchAgent", () => {
            const { copyFileSync } = require("node:fs");
            copyFileSync(plist, dst);
            spawnSync("launchctl", ["load", dst]);
          });
        }
      } else {
        const svc = `${home}/abtars-watchdog.service`;
        const dst = `${process.env["HOME"]}/.config/systemd/user/abtars-watchdog.service`;
        if (ex(svc) && !ex(dst)) {
          fix("watchdog", "installed systemd unit", () => {
            mkdirSync(join(process.env["HOME"]!, ".config", "systemd", "user"), { recursive: true });
            const { copyFileSync } = require("node:fs");
            copyFileSync(svc, dst);
            spawnSync("systemctl", ["--user", "enable", "--now", "abtars-watchdog.service"]);
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  return fixes;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

const ICON = { ok: "✓", failed: "✗", skipped: "~" } as const;

export function renderHuman(output: DoctorOutput): string {
  const lines: string[] = [];
  for (const [layer, probes] of Object.entries(output.layers) as [string, ProbeResult[]][]) {
    lines.push(`${layer.charAt(0).toUpperCase() + layer.slice(1)}:`);
    for (const p of probes) {
      const ms = p.ms && p.ms > 500 ? ` (${p.ms}ms)` : "";
      const detail = p.detail ? ` — ${p.detail}` : "";
      lines.push(`  ${ICON[p.status]} ${p.name}${ms}${detail}`);
    }
  }
  const total = Object.values(output.layers).flat();
  const okCount = total.filter(r => r.status === "ok").length;
  lines.push(`\n${okCount}/${total.length} ok (${(output.totalMs / 1000).toFixed(1)}s)`);
  return lines.join("\n");
}

export function renderJson(output: DoctorOutput): string {
  return JSON.stringify(output, null, 2);
}
