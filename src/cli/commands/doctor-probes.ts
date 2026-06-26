/**
 * doctor-probes.ts — structured health probes grouped by subsystem layer.
 * Replaces scripts/doctor.sh entirely.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";

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
  const env = readEnv();
  const parts: string[] = [];
  if (env.get("TELEGRAM_BOT_TOKEN") || env.get("TELEGRAM_TOKEN")) parts.push("telegram");
  if (env.get("DISCORD_TOKEN") || env.get("DISCORD_BOT_TOKEN")) parts.push("discord");
  if (env.get("IRC_SERVER")) parts.push("irc");

  if (parts.length === 0) return { name: "platforms", status: "failed", detail: "no platform configured" };

  // Check bridge.lock for running status
  const lock = readJson(join(home, "bridge.lock"));
  if (lock?.pid && pidAlive(lock.pid)) {
    return { name: "platforms", status: "ok", detail: parts.map(p => `${p} ✓`).join(", ") };
  }
  return { name: "platforms", status: "ok", detail: `configured: ${parts.join(", ")} (bridge not running)` };
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

  if (bridgeAlive && wdAlive) return { name: "watchdog", status: "ok", detail: `bridge:${bridgePid}, wd:${wdPid}` };
  if (!bridgeAlive && !wdAlive) return { name: "watchdog", status: "failed", detail: `bridge:${bridgePid} dead, wd:${wdPid} dead` };
  if (!wdAlive) return { name: "watchdog", status: "failed", detail: `bridge:${bridgePid} alive, wd:${wdPid} dead (unprotected)` };
  return { name: "watchdog", status: "failed", detail: `bridge:${bridgePid} dead, wd:${wdPid} alive (will restart)` };
}

// ── Heart Probes ─────────────────────────────────────────────────────────────

async function probeHeartbeat(): Promise<ProbeResult> {
  const lock = readJson(join(home, "bridge.lock"));
  if (!lock?.lastHeartbeat) return { name: "heartbeat", status: "skipped", detail: "no bridge.lock" };
  const ageMs = Date.now() - lock.lastHeartbeat;
  if (ageMs > 120_000) return { name: "heartbeat", status: "failed", detail: `stale (${ago(ageMs)})` };
  return { name: "heartbeat", status: "ok", detail: ago(ageMs) };
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
  const dbPath = join(home, "kanban.db");
  if (!existsSync(dbPath)) return { name: "kanban", status: "skipped", detail: "kanban.db not found" };
  try {
    const Db = require("better-sqlite3");
    const db = new Db(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM cards").get() as { cnt: number };
    const stuck = db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE status='running' AND updated_at < datetime('now', '-10 minutes')").get() as { cnt: number };
    db.close();
    const detail = stuck.cnt > 0 ? `${row.cnt} cards, ${stuck.cnt} stuck` : `${row.cnt} cards`;
    return { name: "kanban", status: stuck.cnt > 0 ? "failed" : "ok", detail };
  } catch {
    return { name: "kanban", status: "skipped", detail: "better-sqlite3 not available" };
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
  // Check healer-rules.json
  if (existsSync(join(configDir, "healer-rules.json"))) return { name: "sha", status: "ok", detail: "rules loaded" };
  return { name: "sha", status: "skipped", detail: "no healer rules configured" };
}

// ── Tribe Probes ─────────────────────────────────────────────────────────────

async function probeAgentApi(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "agent-api", status: "skipped", detail: "not enabled" };
  const port = parseInt(env.get("AGENT_API_PORT") || "7100", 10);
  try {
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    return { name: "agent-api", status: "ok", detail: `:${port}` };
  } catch {
    return { name: "agent-api", status: "failed", detail: `:${port} not listening` };
  }
}

async function probePeers(): Promise<ProbeResult> {
  const peersPath = join(configDir, "peers.json");
  const peers = readJson(peersPath);
  if (!peers) return { name: "peers", status: "skipped", detail: "peers.json missing" };
  const peerCount = Object.keys(peers.peers ?? {}).length;
  if (peerCount === 0) return { name: "peers", status: "ok", detail: "no peers configured" };

  const lock = readJson(join(home, "bridge.lock"));
  const gossipAge = lock?.lastGossipBroadcast ? ago(Date.now() - lock.lastGossipBroadcast) : "unknown";
  return { name: "peers", status: "ok", detail: `${peerCount} configured, gossip: ${gossipAge}` };
}

async function probeTls(): Promise<ProbeResult> {
  const env = readEnv();
  if (env.get("ENABLE_AGENT_API") !== "true") return { name: "tls", status: "skipped", detail: "agent-api disabled" };
  const certExists = existsSync(join(configDir, "identity.crt"));
  const keyExists = existsSync(join(configDir, "identity.tls.key"));
  if (certExists && keyExists) return { name: "tls", status: "ok", detail: "certs present" };
  const missing = [!certExists && "identity.crt", !keyExists && "identity.tls.key"].filter(Boolean);
  return { name: "tls", status: "failed", detail: `missing: ${missing.join(", ")}` };
}

async function probeA2a(): Promise<ProbeResult> {
  const peersPath = join(configDir, "peers.json");
  const peers = readJson(peersPath);
  if (!peers?.self?.udpPort) return { name: "a2a", status: "skipped", detail: "no gossip port configured" };

  const port = peers.self.udpPort;
  try {
    const dgram = await import("node:dgram");
    const result = await new Promise<boolean>((resolve) => {
      const sock = dgram.createSocket("udp4");
      const timer = setTimeout(() => { sock.close(); resolve(false); }, 1000);
      sock.on("message", () => { clearTimeout(timer); sock.close(); resolve(true); });
      sock.on("error", () => { clearTimeout(timer); sock.close(); resolve(false); });
      // Send a ping to self — gossip layer will echo/process
      const ping = Buffer.from(JSON.stringify({ type: "ping", from: "__doctor__" }));
      sock.send(ping, port, "127.0.0.1");
    });
    return { name: "a2a", status: result ? "ok" : "failed", detail: result ? `UDP :${port} alive` : `UDP :${port} no response` };
  } catch {
    return { name: "a2a", status: "failed", detail: "UDP probe error" };
  }
}

// ── Soul Probes ──────────────────────────────────────────────────────────────

async function probeMind(): Promise<ProbeResult> {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("abmind", ["doctor", "--json"], { encoding: "utf-8", timeout: 10_000 });
    if (r.status === null || r.error) return { name: "mind", status: "skipped", detail: "abmind not on PATH" };
    const data = JSON.parse(r.stdout);
    const checks: Array<{ name: string; status: string }> = data.checks ?? [];
    const total = checks.length;
    const ok = checks.filter(c => c.status === "ok").length;
    const warnings = checks.filter(c => c.status === "warn" || c.status === "error");
    if (warnings.length === 0) return { name: "mind", status: "ok", detail: `abmind: ${ok}/${total} ok` };
    const names = warnings.slice(0, 3).map(w => w.name).join(", ");
    return { name: "mind", status: "failed", detail: `abmind: ${ok}/${total} (${warnings.length} issues: ${names})` };
  } catch {
    return { name: "mind", status: "skipped", detail: "abmind doctor failed" };
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runAllProbes(): Promise<DoctorOutput> {
  const start = Date.now();

  const [body, heart, brain, soul, tribe] = await Promise.all([
    Promise.all([probePlatforms(), probeDashboard(), probeSecurity(), probeWatchdog()].map(p => timedProbe(() => p))),
    Promise.all([probeHeartbeat()].map(p => timedProbe(() => p))),
    Promise.all([probeTransport(), probeSpin(), probeKanban(), probeSkills(), probeSha()].map(p => timedProbe(() => p))),
    Promise.all([probeMind()].map(p => timedProbe(() => p))),
    Promise.all([probeAgentApi(), probePeers(), probeTls(), probeA2a()].map(p => timedProbe(() => p))),
  ]);

  return { version: "1.0", totalMs: Date.now() - start, layers: { body, heart, brain, soul, tribe } };
}

// ── Fix Logic ────────────────────────────────────────────────────────────────

export async function runFixes(): Promise<FixResult[]> {
  const { chmodSync, unlinkSync, mkdirSync, existsSync: ex, readdirSync: rd, statSync: st, readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const { execSync, spawnSync } = await import("node:child_process");
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
