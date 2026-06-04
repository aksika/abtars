/**
 * system-status.ts — Single source of truth for bridge status.
 * One collector, many renderers. Used by /status (text), dashboard (HTML), future API (JSON).
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { readFileSync, readlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ServiceState } from "./service-registry.js";

const TAG = "system_status";

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
  // Version + commit from release symlink
  let version = "?";
  let commit = "?";
  try {
    const target = basename(readlinkSync(join(homedir(), ".abtars", "current")));
    const dash = target.lastIndexOf("-");
    if (dash > 0) { version = target.slice(0, dash); commit = target.slice(dash + 1); }
  } catch (err) { logAndSwallow("system_status", "op", err); }

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

  return {
    version,
    commit,
    model,
    transportType,
    transportProvider,
    transportReady: ctx.transport?.isReady ?? false,
    uptimeMs: Date.now() - ctx.startedAt,
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
  const lines: string[] = [
    `abTARS v${status.version} (${status.commit})`,
  ];

  // abmind version
  try {
    const abmindManifest = join(homedir(), ".abmind", "manifest.json");
    if (existsSync(abmindManifest)) {
      const m = JSON.parse(readFileSync(abmindManifest, "utf-8"));
      const ver = m.version?.replace(/-[a-f0-9]{7,}$/, "") || null;
      const commit = m.commit?.slice(0, 7) ?? "";
      if (ver) {
        lines.push(`abmind v${ver}${commit ? ` (${commit})` : ""}`);
      } else {
        lines.push("abmind: installed (version unknown)");
      }
    } else {
      lines.push("abmind: not installed");
    }
  } catch (err) { logAndSwallow(TAG, "read abmind manifest", err); }

  // Update check (#440)
  try {
    const { checkForUpdate } = require("./update-check.js") as typeof import("./update-check.js");
    const result = checkForUpdate("abtars", status.version);
    if (result?.updateAvailable) {
      lines.push(`📦 Update available: ${result.current} → ${result.latest}`);
    }
  } catch (err) { logAndSwallow(TAG, "update check", err); }

  lines.push(
    `🤖 Model: ${status.model}`,
    `⏱️ Uptime: ${uptime}`,
    "",
    "🏥 Subsystems:",
  );

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
