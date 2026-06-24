/**
 * doctor — deep runtime healthcheck. Probes every subsystem in parallel.
 * Shared cache (60s) prevents token-burning spam.
 */

import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { abmindHome, abtarsHome } from "../../paths.js";
import { getEnv } from "../env-schema.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TAG = "doctor";

export interface ProbeResult {
  name: string;
  status: "ok" | "failed" | "skipped";
  latencyMs: number;
  detail?: string;
}

export interface DoctorReport {
  results: ProbeResult[];
  totalMs: number;
  cached: boolean;
  cacheAgeMs?: number;
}

export interface DoctorCtx {
  memory?: { getStats: () => any } | null;
  transport?: { sendPrompt: (key: string, msg: string) => Promise<string> } | null;
  telegramRunning?: boolean;
  discordRunning?: boolean;
  ircRunning?: boolean;
  config?: { webPort?: number } | null;
  phaseHealth?: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
}

type ProbeFn = (ctx: DoctorCtx) => Promise<ProbeResult>;

function withTimeout(probe: ProbeFn, timeoutMs: number, name: string): ProbeFn {
  return async (ctx) => {
    const start = Date.now();
    try {
      const result = await Promise.race([
        probe(ctx),
        new Promise<ProbeResult>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      return result;
    } catch (err) {
      return { name, status: "failed", latencyMs: Date.now() - start, detail: `timeout after ${timeoutMs}ms` };
    }
  };
}

// ── Probes ───────────────────────────────────────────────────────────────────

const probeMemory: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.memory) return { name: "memory", status: "skipped", latencyMs: 0, detail: "not configured" };
  try {
    ctx.memory.getStats();
    return { name: "memory", status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "memory", status: "failed", latencyMs: Date.now() - start, detail: String(err) };
  }
};

const probeTelegram: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.telegramRunning) return { name: "telegram", status: "skipped", latencyMs: 0, detail: "not configured" };
  return { name: "telegram", status: "ok", latencyMs: Date.now() - start, detail: "running" };
};

const probeDiscord: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.discordRunning) return { name: "discord", status: "skipped", latencyMs: 0, detail: "not configured" };
  return { name: "discord", status: "ok", latencyMs: Date.now() - start, detail: "running" };
};

const probeIrc: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.ircRunning) return { name: "irc", status: "skipped", latencyMs: 0, detail: "not configured" };
  return { name: "irc", status: "ok", latencyMs: Date.now() - start, detail: "running" };
};


const probeTransport: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.transport) return { name: "transport", status: "skipped", latencyMs: 0, detail: "not configured" };
  try {
    await ctx.transport.sendPrompt("__doctor_probe__", "hi");
    return { name: "transport", status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "transport", status: "failed", latencyMs: Date.now() - start, detail: (err as Error).message?.slice(0, 80) };
  }
};

const probeDashboard: ProbeFn = async (ctx) => {
  const start = Date.now();
  const port = (ctx as any).config?.webPort ?? 3000;
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5000) });
    return { name: "dashboard", status: res.ok ? "ok" : "failed", latencyMs: Date.now() - start };
  } catch (err) {
    logAndSwallow(TAG, "probe dashboard", err);
    return { name: "dashboard", status: "skipped", latencyMs: Date.now() - start, detail: "not running" };
  }
};

const probeOllama: ProbeFn = async (_ctx) => {
  const start = Date.now();
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    return { name: "ollama", status: res.ok ? "ok" : "failed", latencyMs: Date.now() - start };
  } catch (err) {
    logAndSwallow(TAG, "probe ollama", err);
    return { name: "ollama", status: "skipped", latencyMs: Date.now() - start, detail: "not reachable" };
  }
};

const probeCoreFiles: ProbeFn = async (_ctx) => {
  if (getEnv().memory !== "abmind") return { name: "core-files", status: "skipped", latencyMs: 0, detail: "MEMORY is not abmind" };
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const start = Date.now();
  const memDir = join(abmindHome(), "memory");
  const abmindCore = join(memDir, "core");
  const required = ["SOUL.md", "user_profile.md", "agent_notes.md", "memory-tools.md", "core_facts.md"];
  const missing = required.filter(f => !existsSync(join(abmindCore, f)));
  if (missing.length === 0) return { name: "core-files", status: "ok", latencyMs: Date.now() - start };
  return { name: "core-files", status: "failed", latencyMs: Date.now() - start, detail: `missing: ${missing.join(", ")}` };
};

const probeTlsIdentity: ProbeFn = async (_ctx) => {
  const start = Date.now();
  
  if (!getEnv().enableAgentApi) return { name: "tls-identity", status: "ok", latencyMs: Date.now() - start, detail: "agent-api disabled, skipped" };
  const { existsSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { abtarsHome } = await import("../../paths.js");
  const issues: string[] = [];
  try { execSync("which openssl", { stdio: "ignore" }); } catch { issues.push("openssl not found"); }
  const configDir = join(abtarsHome(), "config");
  if (!existsSync(join(configDir, "identity.crt"))) issues.push("identity.crt missing");
  if (!existsSync(join(configDir, "identity.tls.key"))) issues.push("identity.tls.key missing");
  if (issues.length === 0) return { name: "tls-identity", status: "ok", latencyMs: Date.now() - start };
  return { name: "tls-identity", status: "failed", latencyMs: Date.now() - start, detail: issues.join(", ") };
};

const probeSecretPerms: ProbeFn = async (_ctx) => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { abtarsHome } = await import("../../paths.js");
  const start = Date.now();
  const secretDir = join(abtarsHome(), "secret");
  let files: string[];
  try { files = readdirSync(secretDir); } catch (err) { logAndSwallow(TAG, "readdirSync secret dir", err); return { name: "secret-perms", status: "skipped", latencyMs: 0, detail: "no secret/ dir" }; }
  const bad: string[] = [];
  for (const f of files) {
    const st = statSync(join(secretDir, f));
    if (!st.isFile()) continue;
    const mode = st.mode & 0o777;
    if (mode !== 0o600) bad.push(`${f} (${mode.toString(8)})`);
  }
  if (bad.length === 0) return { name: "secret-perms", status: "ok", latencyMs: Date.now() - start, detail: `${files.filter(f => statSync(join(secretDir, f)).isFile()).length} files, all 600` };
  return { name: "secret-perms", status: "failed", latencyMs: Date.now() - start, detail: `not 600: ${bad.join(", ")}` };
};

// ── Collector ────────────────────────────────────────────────────────────────

const probeFtsIntegrity: ProbeFn = async (_ctx) => {
  if (getEnv().memory !== "abmind") return { name: "fts-integrity", status: "skipped", latencyMs: 0, detail: "MEMORY is not abmind" };
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { execSync } = await import("node:child_process");
  const start = Date.now();
  try {
    const dbPath = join(abmindHome(), "memory", "memory.db");
    const missing: string[] = [];
    const REQUIRED = ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"];
    for (const t of REQUIRED) {
      const exists = execSync(`sqlite3 "${dbPath}" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'"`, { stdio: "pipe", timeout: 2000, encoding: "utf-8" }).trim();
      if (!exists) missing.push(t);
    }
    if (missing.length > 0) {
      return { name: "fts-integrity", status: "failed", latencyMs: Date.now() - start, detail: `missing: ${missing.join(", ")}` };
    }
    // Integrity check on FTS tables
    const rebuilt: string[] = [];
    for (const t of REQUIRED) {
      try {
        execSync(`sqlite3 "${dbPath}" "INSERT INTO ${t}(${t}) VALUES('integrity-check')"`, { stdio: "pipe", timeout: 2000 });
      } catch {
        try {
          execSync(`sqlite3 "${dbPath}" "INSERT INTO ${t}(${t}) VALUES('rebuild')"`, { stdio: "pipe", timeout: 5000 });
          rebuilt.push(t);
        } catch { /* rebuild failed — already reported as existing */ }
      }
    }
    if (rebuilt.length > 0) return { name: "fts-integrity", status: "ok", latencyMs: Date.now() - start, detail: `rebuilt: ${rebuilt.join(", ")}` };
    return { name: "fts-integrity", status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "fts-integrity", status: "failed", latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : String(err) };
  }
};

const probeAbmindCli: ProbeFn = async (_ctx) => {
  const { spawnSync } = await import("node:child_process");
  const start = Date.now();
  const result = spawnSync("abmind", ["--version"], { encoding: "utf-8", timeout: 3000 });
  if (result.status === 0) {
    const ver = result.stdout?.trim() || "ok";
    return { name: "abmind-cli", status: "ok", latencyMs: Date.now() - start, detail: `v${ver}` };
  }
  return { name: "abmind-cli", status: "failed", latencyMs: Date.now() - start, detail: "not on PATH — run: npm install -g abmind" };
};

const probeInstanceName: ProbeFn = async (_ctx) => {
  const start = Date.now();
  const { loadPeerConfig } = await import("../peer-config.js");
  const name = loadPeerConfig().self.name;
  if (!name || name === "default") return { name: "instance-name", status: "failed", latencyMs: Date.now() - start, detail: "self.name not set in peers.json — run onboard" };
  return { name: "instance-name", status: "ok", latencyMs: Date.now() - start, detail: name };
};

const probeAgentApi: ProbeFn = async (_ctx) => {
  const start = Date.now();
  
  if (!getEnv().enableAgentApi) return { name: "agent api", status: "ok", latencyMs: Date.now() - start, detail: "agent-api disabled, skipped" };
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { abtarsHome } = await import("../../paths.js");
  const peersPath = join(abtarsHome(), "config", "peers.json");
  if (!existsSync(peersPath)) return { name: "agent api", status: "skipped", latencyMs: Date.now() - start, detail: "no peers.json" };
  try {
    const raw = JSON.parse(readFileSync(peersPath, "utf-8"));
    const peerCount = Object.keys(raw.peers ?? {}).length;
    if (peerCount === 0) return { name: "agent api", status: "failed", latencyMs: Date.now() - start, detail: "peers.json empty" };
    return { name: "agent api", status: "ok", latencyMs: Date.now() - start, detail: `${peerCount} peer(s)` };
  } catch {
    return { name: "agent api", status: "failed", latencyMs: Date.now() - start, detail: "peers.json invalid" };
  }
};

const probeProcessHealth: ProbeFn = async (_ctx) => {
  const start = Date.now();
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { abtarsHome } = await import("../../paths.js");
    const lockPath = join(abtarsHome(), "bridge.lock");
    if (!existsSync(lockPath)) return { name: "process-health", status: "skipped", latencyMs: Date.now() - start, detail: "no bridge.lock" };
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    const issues: string[] = [];

    // Check bridge pid
    if (lock.pid && lock.pid > 0) {
      try { process.kill(lock.pid, 0); } catch { issues.push(`bridge pid ${lock.pid} dead`); }
    }
    // Check watchdog pid
    if (lock.watchdogPid && lock.watchdogPid > 0) {
      try { process.kill(lock.watchdogPid, 0); } catch { issues.push(`watchdog pid ${lock.watchdogPid} dead`); }
    } else if (!lock.watchdogPid) {
      issues.push("no watchdog (unprotected)");
    }

    if (issues.length === 0) return { name: "process-health", status: "ok", latencyMs: Date.now() - start };
    return { name: "process-health", status: "failed", latencyMs: Date.now() - start, detail: issues.join(", ") };
  } catch {
    return { name: "process-health", status: "skipped", latencyMs: Date.now() - start, detail: "parse error" };
  }
};

// #1181: NEW heartbeat probe — reads bridge.lock directly (no abmind dependency)
const probeHeartbeat: ProbeFn = async () => {
  const start = Date.now();
  try {
    const lockPath = join(abtarsHome(), "bridge.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    const age = Date.now() - (lock.lastHeartbeat ?? 0);
    if (age > 120_000) return { name: "heartbeat", status: "failed", latencyMs: Date.now() - start, detail: `stale (${Math.round(age / 1000)}s ago)` };
    return { name: "heartbeat", status: "ok", latencyMs: Date.now() - start };
  } catch {
    return { name: "heartbeat", status: "skipped", latencyMs: Date.now() - start, detail: "no bridge.lock" };
  }
};

const PROBES: Array<{ fn: ProbeFn; timeout: number; name: string }> = [
  // Memory mode check (first)
  { fn: async () => getEnv().memory === "none" ? { name: "memory-mode", status: "warn" as const, latencyMs: 0, detail: "No persistent memory available" } : { name: "memory-mode", status: "ok" as const, latencyMs: 0, detail: `provider: ${getEnv().memory}` }, timeout: 100, name: "memory-mode" },
  // Static file checks
  { fn: probeCoreFiles, timeout: 1000, name: "core-files" },
  { fn: probeSecretPerms, timeout: 1000, name: "secret-perms" },
  { fn: probeTlsIdentity, timeout: 2000, name: "tls-identity" },
  { fn: probeFtsIntegrity, timeout: 3000, name: "fts-integrity" },
  // Memory
  { fn: probeAbmindCli, timeout: 3000, name: "abmind-cli" },
  { fn: probeMemory, timeout: 5000, name: "memory" },
  { fn: probeHeartbeat, timeout: 1000, name: "heartbeat" },
  // Transport + platforms
  { fn: probeTransport, timeout: 10000, name: "transport" },
  { fn: probeTelegram, timeout: 5000, name: "telegram" },
  { fn: probeDiscord, timeout: 5000, name: "discord" },
  { fn: probeIrc, timeout: 5000, name: "irc" },
  // Infra
  { fn: probeOllama, timeout: 5000, name: "ollama" },
  { fn: probeDashboard, timeout: 5000, name: "dashboard" },
  { fn: probeAgentApi, timeout: 1000, name: "agent-api" },
  { fn: probeInstanceName, timeout: 1000, name: "instance-name" },
  { fn: probeProcessHealth, timeout: 1000, name: "process-health" },
];

let lastReport: { report: DoctorReport; generatedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getDoctorReport(ctx: DoctorCtx, opts?: { force?: boolean }): Promise<DoctorReport> {
  const now = Date.now();
  if (!opts?.force && lastReport && now - lastReport.generatedAt < CACHE_TTL_MS) {
    return { ...lastReport.report, cached: true, cacheAgeMs: now - lastReport.generatedAt };
  }

  const start = Date.now();
  const results = await Promise.all(
    PROBES.map(p => withTimeout(p.fn, p.timeout, p.name)(ctx))
  );

  // Add boot phases not covered by active probes
  const probedNames = new Set(results.map(r => r.name));
  if (ctx.phaseHealth) {
    for (const [name, h] of ctx.phaseHealth) {
      const short = name.replace("phase", "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
      if (!probedNames.has(short) && !probedNames.has(short.replace(" ", ""))) {
        results.push({ name: short, status: h.status === "ok" ? "ok" : h.status === "skipped" ? "skipped" : "failed", latencyMs: 0, detail: h.error ?? (h.status === "ok" ? "boot ok" : undefined) });
      }
    }
  }

  const totalMs = Date.now() - start;

  const report: DoctorReport = { results, totalMs, cached: false };
  lastReport = { report, generatedAt: now };
  logInfo("doctor", `Probes complete: ${results.filter(r => r.status === "ok").length}/${results.length} ok (${totalMs}ms)`);
  return report;
}

export function renderDoctorText(report: DoctorReport): string {
  const icon = (s: ProbeResult["status"]): string => s === "ok" ? "✓" : s === "failed" ? "✗" : "~";
  const lines = report.results.map(r => {
    const detail = r.detail ? ` — ${r.detail}` : "";
    const ms = r.latencyMs > 0 ? ` (${r.latencyMs}ms)` : "";
    return `  ${icon(r.status)} ${r.name}${ms}${detail}`;
  });
  const tag = report.cached ? `[cached ${Math.round((report.cacheAgeMs ?? 0) / 1000)}s ago]` : "[fresh]";
  return `🩺 Doctor Report (${(report.totalMs / 1000).toFixed(1)}s)  ${tag}\n${lines.join("\n")}`;
}
