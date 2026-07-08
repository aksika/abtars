/**
 * system-status.ts — Single source of truth for bridge status.
 * One collector, many renderers. Used by /status (text), dashboard (HTML), future API (JSON).
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { getInstanceName } from "./soul-bundle.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServiceState } from "./service-registry.js";

export interface SubsystemHealth {
  name: string;
  status: "ok" | "failed" | "skipped" | "stopped" | "retrying";
  detail?: string;
}

export interface SystemStatus {
  version: string;
  commit: string;
  model: string;
  transportType: string;
  transportProvider: string;
  transportReady: boolean;
  uptimeMs: number;
  contextPercent: number;
  sleepStatus: string | null;
  subsystems: SubsystemHealth[];
  tasks: { recurring: number; pending: number; paused: number };
  lastBackup: string | null;
  // New fields for redesigned /status output
  securityMode: string;
  trustMode: boolean;
  activeSessions: number;
  kanban: { active: number; total: number } | null;
  soulBundle: { available: number; total: number } | null;
  peersConfigured: number;
  /** Per-platform running state: key = "telegram"/"discord"/"irc", value = running */
  platformStates: Record<string, boolean>;
}

export interface StatusContext {
  phaseHealth: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
  registry: { getStates(): Record<string, ServiceState> };
  transport: { isReady: boolean } | null;
  startedAt: number;
  bridgeLockPath: string;
  heartbeat: { intervalMs: number } | null;
}

const SOUL_CORE_FILES = ["SOUL.md", "user_profile.md", "agent_notes.md", "memory-tools.md", "core_facts.md"] as const;
const PLATFORM_NAMES = ["telegram", "discord", "irc"] as const;

export async function getSystemStatus(ctx: StatusContext): Promise<SystemStatus> {
  // Version + commit from manifest.json (single source of truth)
  const { getDeployedVersion } = await import("../paths.js");
  const deployed = getDeployedVersion();
  const version = deployed.version;
  const commit = deployed.commit || "?";

  // Model + transport
  let model = "unknown";
  let transportType = "unknown";
  let transportProvider = "unknown";
  try {
    const { loadTransport, resolveAgent } = await import("./transport-config.js");
    const tc = loadTransport();
    const prof = tc ? resolveAgent("professor", tc) : null;
    if (prof) {
      model = prof.model;
      transportType = (prof.provider.transport ?? "acp").toUpperCase();
      transportProvider = prof.providerName ?? "unknown";
    }
  } catch (err) { logAndSwallow("system_status", "op", err); }

  // Subsystem health: merge phaseHealth + ServiceRegistry live state
  const serviceStates = ctx.registry.getStates();
  const subsystems: SubsystemHealth[] = [];

  for (const [name, health] of ctx.phaseHealth) {
    const entry: SubsystemHealth = { name, status: health.status };

    const svcName = phaseToService(name);
    if (svcName && serviceStates[svcName]) {
      const svc = serviceStates[svcName] as ServiceState;
      if (health.status === "ok" && !svc.running) {
        entry.status = svc.retrying ? "retrying" : "stopped";
      }
      if (svc.retrying) entry.detail = `retry #${svc.retrying.attempt}`;
    }

    if (name === "phaseTransport" && health.status === "ok" && ctx.transport) {
      entry.detail = `${transportType} (${transportProvider}), ${ctx.transport.isReady ? "ready" : "not ready"}`;
    }
    if (name === "phaseHeartbeat" && health.status === "ok" && ctx.heartbeat) {
      try {
        const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8"));
        const ago = Math.round((Date.now() - (lock.lastHeartbeat || 0)) / 60000);
        entry.detail = `${Math.round(ctx.heartbeat.intervalMs / 1000)}s, last tick ${ago}m ago`;
      } catch (err) { logAndSwallow("system_status", "op", err); }
    }
    if (name === "phaseDashboard" && health.status === "ok") {
      entry.detail = `:${process.env["WEB_PORT"] || "3000"}`;
    }

    subsystems.push(entry);
  }

  // Platform running states (telegram, discord, irc)
  const platformStates: Record<string, boolean> = {};
  for (const name of PLATFORM_NAMES) {
    const svc = serviceStates[name];
    if (svc) platformStates[name] = svc.running;
  }

  // Tasks
  let tasks = { recurring: 0, pending: 0, paused: 0 };
  try {
    const { readEntries } = await import("./tasks/task-store.js");
    const entries = readEntries();
    tasks = {
      recurring: entries.filter((e: any) => e.schedule && !e.paused).length,
      pending: entries.filter((e: any) => !e.fired && !e.schedule).length,
      paused: entries.filter((e: any) => e.paused).length,
    };
  } catch (err) { logAndSwallow("system_status", "op", err); }

  // Last backup
  let lastBackup: string | null = null;
  try {
    const { readdirSync } = await import("node:fs");
    const bd = join(homedir(), ".backup-abtars");
    const bk = readdirSync(bd).filter((f: string) => f.startsWith("abtars-") && (f.endsWith(".zip") || f.endsWith(".7z"))).sort();
    if (bk.length > 0) lastBackup = bk[bk.length - 1] ?? null;
  } catch (err) { logAndSwallow("system_status", "op", err); }

  // Context percent + sleep status from bridge.lock
  let contextPercent = -1;
  let sleepStatus: string | null = null;
  try {
    const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8"));
    if (typeof lock.contextPercent === "number") contextPercent = lock.contextPercent;
    sleepStatus = lock.sleepStatus ?? null;
  } catch { /* ignore */ }

  // Security mode + trust
  let securityMode = "off";
  let trustMode = false;
  try {
    const { getSecurityMode } = await import("./guardrails.js");
    const { getEnv } = await import("./env-schema.js");
    securityMode = getSecurityMode();
    trustMode = (getEnv() as any).trustMode === true;
  } catch (err) { logAndSwallow("system_status", "trust", err); }

  // Active Spin session count
  let activeSessions = 0;
  try {
    const { spin } = await import("./spin.js");
    activeSessions = spin.listAllSessions().length;
  } catch (err) { logAndSwallow("system_status", "spin", err); }

  // Kanban active/total via kanbanList
  let kanban: SystemStatus["kanban"] = null;
  try {
    const { kanbanList } = await import("./tasks/kanban-board.js");
    const all = kanbanList();
    const active = all.filter((c: any) => ["queued", "running", "delivering"].includes(c.status)).length;
    kanban = { active, total: all.length };
  } catch (err) { logAndSwallow("system_status", "kanban", err); }

  // Soul bundle availability (only when abmind memory)
  let soulBundle: SystemStatus["soulBundle"] = null;
  try {
    const { getEnv } = await import("./env-schema.js");
    const { abmindHome } = await import("../paths.js");
    const memoryProvider = (getEnv() as any).memory ?? "abmind";
    if (memoryProvider === "abmind" || memoryProvider === "auto") {
      const coreDir = join(abmindHome(), "memory", "core");
      if (existsSync(coreDir)) {
        const available = SOUL_CORE_FILES.filter(f => existsSync(join(coreDir, f))).length;
        soulBundle = { available, total: SOUL_CORE_FILES.length };
      }
    }
  } catch (err) { logAndSwallow("system_status", "soul", err); }

  // Peers configured count (exclude "self" entry)
  let peersConfigured = 0;
  try {
    const { abtarsHome } = await import("../paths.js");
    const peersPath = join(abtarsHome(), "config", "peers.json");
    if (existsSync(peersPath)) {
      const peers = JSON.parse(readFileSync(peersPath, "utf-8")) as Record<string, unknown>;
      peersConfigured = Object.keys(peers).filter(k => k !== "self").length;
    }
  } catch (err) { logAndSwallow("system_status", "peers", err); }

  return {
    version,
    commit,
    model,
    transportType,
    transportProvider,
    transportReady: ctx.transport?.isReady ?? false,
    uptimeMs: Date.now() - ctx.startedAt,
    contextPercent,
    sleepStatus,
    subsystems,
    tasks,
    lastBackup,
    securityMode,
    trustMode,
    activeSessions,
    kanban,
    soulBundle,
    peersConfigured,
    platformStates,
  };
}

/** Map phase names to ServiceRegistry service names (for live state merge). */
function phaseToService(phaseName: string): string | null {
  switch (phaseName) {
    case "agentApi": return "agent-api";
    default: return null;
  }
}

/** Render SystemStatus as plain text for Telegram/Discord /status command. */
export function renderStatusText(status: SystemStatus): string {
  const uptime = formatUptime(status.uptimeMs);
  const failures = status.subsystems.filter(s => s.status === "failed" || s.status === "stopped").length;
  const mood = failures === 0 ? "😊" : failures <= 2 ? "😐" : "😟";
  const sleepLabel = status.sleepStatus ?? "awake";

  const lines: string[] = [
    `abTARS™ ${getInstanceName()} — ${sleepLabel} ${mood}`,
    `  PID ${process.pid} (up ${uptime})`,
  ];

  // Watchdog
  const wdPid = process.env["ABTARS_WATCHDOG_PID"];
  if (wdPid && wdPid !== "0") {
    try { process.kill(Number(wdPid), 0); lines.push(`  Watchdog: PID ${wdPid}`); }
    catch { lines.push("  Watchdog: not running (stale PID)"); }
  } else {
    lines.push("  Watchdog: not detected");
  }

  lines.push(`  Security: ${status.securityMode}`);
  if (status.trustMode) lines.push("  Trust: (trusted)");

  // ── Body ──────────────────────────────────────────────────────────────
  lines.push("", "Body:");

  // Platforms: per-platform from collected platformStates
  const platformEntries = (["telegram", "discord", "irc"] as const)
    .filter(name => name in status.platformStates)
    .map(name => `${status.platformStates[name] ? "✓" : "✗"} ${name.charAt(0).toUpperCase() + name.slice(1)}`);

  if (platformEntries.length > 0) {
    lines.push(`  ✓ platforms: ${platformEntries.join("  ")}`);
  } else {
    const platformSub = status.subsystems.find(s => s.name === "phasePlatforms");
    lines.push(`  ${subIcon(platformSub)} platforms${platformSub?.detail ? `: ${platformSub.detail}` : ""}`);
  }

  const dashSub = status.subsystems.find(s => s.name === "phaseDashboard");
  const webPort = (process.env["WEB_PORT"] ?? "").replace(/^:/, "");
  if (dashSub && dashSub.status !== "skipped") {
    lines.push(`  ${subIcon(dashSub)} dashboard${webPort ? `: ${webPort}` : ""}`);
  } else {
    lines.push("  ○ dashboard: disabled");
  }

  // ── Heart ─────────────────────────────────────────────────────────────
  lines.push("", "Heart:");

  try {
    const { getHeartbeatInstance } = require("./heartbeat-system.js") as typeof import("./heartbeat-system.js");
    const hb = getHeartbeatInstance();
    if (hb) {
      const intervalSec = Math.round(hb.intervalMs / 1000);
      let lastTickAgo = "";
      try {
        const lock = JSON.parse(readFileSync(join(homedir(), ".abtars", "bridge.lock"), "utf-8"));
        if (lock.lastHeartbeat) {
          const agoSec = Math.round((Date.now() - lock.lastHeartbeat) / 1000);
          lastTickAgo = ` / ${agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`}`;
        }
      } catch { /* ignore */ }
      lines.push(`  ${hb.isRunning ? "✓" : "✗"} heartbeat: ${intervalSec}s${lastTickAgo}`);
      lines.push(`  ✓ internal tasks: ${hb.getTaskNames().length}`);
    } else {
      lines.push("  ✗ heartbeat: not running");
    }
  } catch { lines.push("  ○ heartbeat: not loaded"); }

  // ── Brain ─────────────────────────────────────────────────────────────
  lines.push("", "Brain:");

  const modelShort = status.model.split("/").pop() ?? status.model;
  let lastPromptStr = "";
  try {
    const lock = JSON.parse(readFileSync(join(homedir(), ".abtars", "bridge.lock"), "utf-8"));
    if (lock.lastPromptAt) {
      const agoSec = Math.round((Date.now() - lock.lastPromptAt) / 1000);
      lastPromptStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
    }
  } catch { /* ignore */ }
  lines.push(`  ✓ model: ${modelShort}${lastPromptStr ? ` / ${lastPromptStr}` : ""}`);

  lines.push(`  ✓ spin: ${status.activeSessions} active session${status.activeSessions !== 1 ? "s" : ""}`);

  if (status.kanban) {
    lines.push(`  ✓ kanban: ${status.kanban.active}/${status.kanban.total}`);
  } else {
    lines.push("  ✗ kanban: not initialized");
  }

  // SHA — check sha-policy.json existence (same as doctor probe)
  try {
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const policyExists = existsSync(join(abtarsHome(), "config", "sha-policy.json"));
    lines.push(`  ${policyExists ? "✓" : "~"} SHA: ${policyExists ? "rules configured" : "no policy configured"}`);
  } catch {
    lines.push("  ~ SHA: no policy configured");
  }

  try {
    const { getSkillCache } = require("../capabilities/hotskills/index.js") as typeof import("../capabilities/hotskills/index.js");
    const skills = getSkillCache();
    const active = skills.filter((s: any) => !s.skipped).length;
    lines.push(`  ✓ skills: ${active} active`);
  } catch { /* hotskills not loaded */ }

  // ── Soul ──────────────────────────────────────────────────────────────
  lines.push("", "Soul:");

  if (status.soulBundle) {
    const allPresent = status.soulBundle.available === status.soulBundle.total;
    lines.push(`  ${allPresent ? "✓" : "~"} memory: abmind working`);
    lines.push(`    soul bundle: ${status.soulBundle.available}/${status.soulBundle.total} available`);
  } else {
    lines.push("  ✗ memory: none");
  }

  // ── Tribe ─────────────────────────────────────────────────────────────
  lines.push("", "Tribe:");

  const apiSub = status.subsystems.find(s => s.name === "agentApi");
  const apiPort = (process.env["AGENT_API_PORT"] ?? "").replace(/^:/, "");
  lines.push(`  ${subIcon(apiSub)} a2a${apiPort ? `: ${apiPort} enabled` : ""}`);

  if (status.peersConfigured > 0) {
    lines.push(`  ✓ peers: ${status.peersConfigured} configured`);
  } else {
    lines.push("  ○ peers: none configured");
  }

  // Gossip: only runs when peers are configured. Read freshness from bridge.lock.
  if (status.peersConfigured > 0) {
    const gossipPort = (process.env["GOSSIP_PORT"] ?? "5355").replace(/^:/, "");
    let broadcast = "no broadcast yet";
    try {
      const lock = JSON.parse(readFileSync(join(homedir(), ".abtars", "bridge.lock"), "utf-8"));
      if (typeof lock.lastGossipBroadcast === "number") {
        const agoSec = Math.round((Date.now() - lock.lastGossipBroadcast) / 1000);
        broadcast = `last broadcast ${agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`}`;
      }
    } catch { /* ignore */ }
    lines.push(`  ✓ gossip: ${gossipPort} / ${broadcast}`);
  } else {
    lines.push("  ○ gossip: disabled");
  }

  // ── Footer ────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`Tasks: ${status.tasks.recurring} recurring, ${status.tasks.pending} pending${status.tasks.paused ? `, ${status.tasks.paused} paused` : ""}`);
  if (status.lastBackup) lines.push(`Last backup: ${status.lastBackup}`);

  return lines.join("\n");
}

function subIcon(sub: SubsystemHealth | undefined): string {
  if (!sub) return "○";
  switch (sub.status) {
    case "ok": return "✓";
    case "skipped": return "○";
    default: return "✗";
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
