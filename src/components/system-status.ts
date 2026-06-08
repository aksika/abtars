/**
 * system-status.ts — Single source of truth for bridge status.
 * One collector, many renderers. Used by /status (text), dashboard (HTML), future API (JSON).
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { readFileSync } from "node:fs";
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
}

export interface StatusContext {
  phaseHealth: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
  registry: { getStates(): Record<string, ServiceState> };
  transport: { isReady: boolean } | null;
  startedAt: number;
  bridgeLockPath: string;
  heartbeat: { intervalMs: number } | null;
}

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

    // For platform services, override with live ServiceRegistry state
    const svcName = phaseToService(name);
    if (svcName && serviceStates[svcName]) {
      const svc = serviceStates[svcName] as ServiceState;
      if (health.status === "ok" && !svc.running) {
        entry.status = svc.retrying ? "retrying" : "stopped";
      }
      if (svc.retrying) {
        entry.detail = `retry #${svc.retrying.attempt}`;
      }
    }

    // Add contextual detail for specific phases
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
    const bk = readdirSync(bd).filter((f: string) => f.startsWith("abtars-")).sort();
    if (bk.length > 0) lastBackup = bk[bk.length - 1] ?? null;
  } catch (err) { logAndSwallow("system_status", "op", err); }

  // Context percent from bridge.lock
  let contextPercent = -1;
  try {
    const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8"));
    if (typeof lock.contextPercent === "number") contextPercent = lock.contextPercent;
  } catch { /* ignore */ }

  // Sleep status
  let sleepStatus: string | null = null;
  try {
    const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8"));
    sleepStatus = lock.sleepStatus ?? null;
  } catch { /* ignore */ }

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
  };
}

/** Map phase names to ServiceRegistry service names (for live state merge). */
function phaseToService(phaseName: string): string | null {
  switch (phaseName) {
    case "phasePlatforms": return null; // platforms registers telegram + discord separately
    case "phaseDashboard": return null;
    case "phaseAgentApi": return "agent-api";
    default: return null;
  }
}

/** Render SystemStatus as plain text for Telegram/Discord /status command. */
export function renderStatusText(status: SystemStatus): string {
  const uptime = formatUptime(status.uptimeMs);
  const name = process.env["AGENT_NAME"] ?? process.env["BOT_NAME"] ?? "abtars";
  const failures = status.subsystems.filter(s => s.status === "failed").length;
  const mood = failures === 0 ? "😊" : failures <= 3 ? "😐" : "😟";
  const lines: string[] = [
    `abTARS™ — online ${mood}`,
    `  PID ${process.pid} (up ${uptime})`,
  ];

  // Watchdog
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const wdPid = execFileSync("pgrep", ["-f", "watchdog.sh"], { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0];
    if (wdPid) lines.push(`  Watchdog: PID ${wdPid} (bash)`);
    else lines.push("  Watchdog: not running");
  } catch { lines.push("  Watchdog: not detected"); }

  // Platforms
  const platforms = status.subsystems.find(s => s.name === "phasePlatforms");
  if (platforms?.detail) lines.push(`  Platforms: ${platforms.detail}`);

  // Model + context
  lines.push(`  Model: ${status.model.split("/").pop() ?? status.model}`);
  if (status.contextPercent >= 0) lines.push(`  Context: ${status.contextPercent}%`);

  // Last prompt
  try {
    const lock = JSON.parse(readFileSync(join(homedir(), ".abtars", "bridge.lock"), "utf-8"));
    if (lock.lastPromptAt) {
      const ago = Math.round((Date.now() - lock.lastPromptAt) / 1000);
      lines.push(`  Last prompt: ${ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`}`);
    }
  } catch { /* no lock */ }

  // Sleep
  if (status.sleepStatus) lines.push(`  Sleep: ${status.sleepStatus}`);

  // Skills
  try {
    const { getSkillCache } = require("../capabilities/hotskills/index.js") as typeof import("../capabilities/hotskills/index.js");
    const skills = getSkillCache();
    if (skills.length > 0) {
      const active = skills.filter(s => !s.skipped).length;
      lines.push(`  Skills: ${active} active`);
    }
  } catch { /* hotskills not loaded */ }

  lines.push("", "🏥 Subsystems:");

  for (const s of status.subsystems) {
    const icon = s.status === "ok" ? "✓" : s.status === "skipped" ? "○" : "✗";
    const label = s.name.replace("phase", "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
    const detail = s.detail ? ` — ${s.detail}` : "";
    lines.push(`  ${icon} ${label}${detail}`);
  }

  lines.push("");
  lines.push(`⏰ Tasks: ${status.tasks.recurring} recurring, ${status.tasks.pending} pending${status.tasks.paused ? `, ${status.tasks.paused} paused` : ""}`);
  if (status.lastBackup) lines.push(`💾 Last backup: ${status.lastBackup}`);

  return lines.join("\n");
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
