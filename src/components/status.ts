/**
 * status.ts — Single source of truth for status data, with two renderers.
 *
 *   getStatus(ctx?)  → StatusView (always; one data function)
 *                         │
 *                ┌────────┴────────┐
 *                ▼                 ▼
 *       renderOperatorStatus  renderChatStatus
 *           (CLI format)        (chat /status format)
 *
 * The data is the contract: both renderers consume the same StatusView. The two
 * renderers exist because the operator (terminal) and chat (Telegram/Discord/IRC)
 * audiences want different things — the operator wants version+commit on line 1
 * and the full key-value body, the chat audience wants a TL;DR mood line and
 * focused sections (Body/Heart/Brain/Soul/Tribe).
 *
 * Used by:
 *   - `abtars status` (CLI)         — renderOperatorStatus(view)
 *   - `abtars status --json` (CLI)  — JSON.stringify(view) for scripts
 *   - `/status` (bridge chat)       — renderChatStatus(view)
 *   - `/status full` (bridge chat)  — renderChatStatus(view) + env dump
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logAndSwallow } from "./log-and-swallow.js";
import { getInstanceName } from "./soul-bundle.js";
import { packagePaths, readManifest } from "../cli/deploy-lib-import.js";
import type { ServiceState } from "./service-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DaemonInfo {
  scope: "system" | "user";
  unit: string;
  active: string;
  mainPid: number | null;
  bridgeUptimeSeconds: number | null;
  startReason: string | null;
  heartbeatStaleSeconds: number | null;
}

export interface TuiInfo {
  present: boolean;
  enabled: boolean;
  onTuiBranch: boolean;
  bridgeTty: string;
  clientsAttached: number;
}

export interface RuntimeView {
  instanceName: string;
  sleepStatus: string;
  mood: "😊" | "😐" | "😟";
  pid: number;
  uptimeMs: number;
  watchdog: { pid: number | null; alive: boolean };
  securityMode: string;
  trustMode: boolean;
  transport: { ready: boolean; type: string; provider: string; model: string };
  contextPercent: number | null;
  platformStates: Record<string, boolean>;
  heartbeat: {
    running: boolean;
    intervalSec: number;
    lastTickSecondsAgo: number | null;
    internalTaskCount: number;
  };
  activeSessions: number;
  kanban: { active: number; total: number } | null;
  shaPolicyConfigured: boolean;
  skillsActive: number;
  soulBundle: { available: number; total: number } | null;
  a2a: { running: boolean; port: number | null };
  peersConfigured: number;
  gossip: { configured: boolean; port: number; lastBroadcastSecondsAgo: number | null };
  tasks: { recurring: number; pending: number; paused: number };
  lastBackup: string | null;
}

export interface StatusView {
  // Operator view (always populated when manifest is readable)
  home: string;
  version: string | null;
  commit: string | null;
  branch: string | null;
  source: string;
  installMode: string;
  activatedAt: string | null;
  appPresent: boolean;
  rollbackAvailable: number;
  previousVersion: string | null;
  host: string | null;
  bridge: {
    pid: number | null;
    alive: boolean;
    startedAt: string | null;
    startReason: string | null;
    lastHeartbeatStaleSeconds: number | null;
  };
  dashboard: { port: number | null };
  agentApi: { port: number | null };
  daemon: DaemonInfo | null;
  tui: TuiInfo;
  // Runtime view (only when ctx is passed — bridge call site)
  runtime?: RuntimeView;
  warnings: string[];
}

export interface BridgeStatusCtx {
  phaseHealth: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
  registry: { getStates(): Record<string, ServiceState> };
  transport: { isReady: boolean; contextPercent?: number; model?: string } | null;
  startedAt: number;
  bridgeLockPath: string;
  heartbeatIntervalMs: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOUL_CORE_FILES = [
  "SOUL.md",
  "user_profile.md",
  "agent_notes.md",
  "memory-tools.md",
  "core_facts.md",
] as const;
const PLATFORM_NAMES = ["telegram", "discord", "irc"] as const;
const SYSTEMCTL_TIMEOUT_MS = 3000;

// ── getStatus (the one data function) ────────────────────────────────────────

export async function getStatus(ctx?: BridgeStatusCtx): Promise<StatusView> {
  const warnings: string[] = [];
  const paths = packagePaths("abtars");
  const home = paths.home;

  // Manifest
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version ?? null;
  const commit = manifest?.commit ?? null;
  const branch = manifest?.branch ?? null;
  const source = manifest?.source ?? "dev";
  const installMode = manifest?.installMode ?? "daemon";
  const activatedAt = manifest?.activatedAt ?? null;
  const host = manifest?.host ?? null;
  const previousVersion = manifest?.previousVersion ?? null;

  const appPresent = existsSync(paths.app);
  if (!appPresent) warnings.push("app/ directory missing");

  // Rollback count
  let rollbackAvailable = 0;
  try {
    const history: string[] = JSON.parse(readFileSync(paths.releasesHistory, "utf-8"));
    rollbackAvailable = Math.min(history.length - 1, 3);
  } catch {}

  // Bridge state from bridge.lock
  const bridgeState = readBridgeLock(ctx?.bridgeLockPath ?? join(home, "bridge.lock"));
  if (bridgeState.lockReadError) warnings.push("bridge.lock unreadable");

  // Ports from .env
  const { dashboardPort, agentApiPort } = readPorts(join(home, "config", ".env"));

  // Daemon section
  const daemon = collectDaemon(
    installMode,
    bridgeState.startedAtMs,
    bridgeState.startReason,
    bridgeState.lastHeartbeatMs,
    warnings,
  );

  // TUI section
  const tui = collectTui(branch, bridgeState.pid);

  // Runtime (only if ctx)
  const runtime = ctx ? await collectRuntime(ctx, warnings) : undefined;

  return {
    home,
    version,
    commit,
    branch,
    source,
    installMode,
    activatedAt,
    appPresent,
    rollbackAvailable,
    previousVersion,
    host,
    bridge: {
      pid: bridgeState.pid,
      alive: bridgeState.alive,
      startedAt: bridgeState.startedAt,
      startReason: bridgeState.startReason,
      lastHeartbeatStaleSeconds: bridgeState.heartbeatStaleSeconds,
    },
    dashboard: { port: dashboardPort },
    agentApi: { port: agentApiPort },
    daemon,
    tui,
    runtime,
    warnings,
  };
}

// ── renderOperatorStatus (CLI format) ────────────────────────────────────────

/**
 * CLI renderer. Mirrors the existing `abtars status` output: 14 operator lines
 * (home, version, commit, branch, source, installMode, activatedAt, app/,
 * rollback, previousVersion, host, bridge, dashboard, agentApi) plus the new
 * `daemon:` and `tui:` sections. Emits nothing from `view.runtime` (the CLI
 * never has in-process refs).
 */
export function renderOperatorStatus(view: StatusView): string {
  const lines: string[] = [];
  lines.push(`abtars status`);
  lines.push(`  home:          ${view.home}`);
  lines.push(`  version:       ${view.version ?? "(unset — run update)"}`);
  lines.push(`  commit:        ${view.commit ?? "(unknown)"}`);
  lines.push(`  branch:        ${view.branch ?? "(unknown)"}`);
  lines.push(`  source:        ${view.source}`);
  lines.push(`  mode:          ${view.installMode}`);
  lines.push(`  activated:     ${view.activatedAt ?? "(unknown)"}`);
  lines.push(`  app/:          ${view.appPresent ? "✓ present" : "✗ missing"}`);
  lines.push(`  rollback:      ${view.rollbackAvailable > 0 ? `${view.rollbackAvailable} available` : "○ none"}`);
  lines.push(`  previous:      ${view.previousVersion ?? "(none)"}`);
  lines.push(`  host:          ${view.host ?? "(unknown)"}`);

  // Bridge
  if (view.bridge.pid) {
    lines.push(
      `  bridge:        ${view.bridge.alive ? "● running" : "✗ dead"} (pid ${view.bridge.pid})`,
    );
  } else {
    lines.push(`  bridge:        ○ stopped`);
  }

  // Ports
  if (view.dashboard.port) lines.push(`  dashboard:     :${view.dashboard.port}`);
  if (view.agentApi.port) lines.push(`  agent-api:     :${view.agentApi.port}`);

  // Daemon section
  if (view.daemon) {
    const d = view.daemon;
    lines.push(`  daemon:        ${d.unit} (${d.scope})`);
    lines.push(`                 ${stateIcon(d.active)} ${d.active}`);
    if (d.mainPid !== null) lines.push(`                 pid: ${d.mainPid}`);
    if (d.bridgeUptimeSeconds !== null) {
      lines.push(`                 bridge uptime: ${formatUptime(d.bridgeUptimeSeconds * 1000)}`);
    }
    if (d.startReason) lines.push(`                 start reason: ${d.startReason}`);
    if (d.heartbeatStaleSeconds !== null && d.heartbeatStaleSeconds > 60) {
      lines.push(`                 ⚠ heartbeat stale: ${d.heartbeatStaleSeconds}s`);
    }
  } else if (view.installMode === "daemon") {
    lines.push(`  daemon:        ⚠ mode=daemon but no unit installed`);
    lines.push(`                 install: sudo $(which abtars) daemon install`);
  }

  // TUI section
  const tuiIcon = view.tui.present ? "✓" : "○";
  const tuiState = view.tui.present ? "present" : "not present";
  lines.push(
    `  tui:           ${tuiIcon} ${tuiState} (enabled=${view.tui.enabled}, branch=${view.tui.onTuiBranch ? "yes" : "no"}, bridge tty=${view.tui.bridgeTty})`,
  );
  lines.push(`                 clients attached: ${view.tui.clientsAttached}`);

  return lines.join("\n") + "\n";
}

// ── renderChatStatus (chat /status format) ───────────────────────────────────

/**
 * Chat renderer. Mirrors the existing `/status` output: mood + pid/uptime
 * header, then Body/Heart/Brain/Soul/Tribe sections. Emits nothing from the
 * operator-view fields the chat audience doesn't need.
 */
export function renderChatStatus(view: StatusView): string {
  const r = view.runtime;
  if (!r) {
    return "⚠ runtime not available (no in-process bridge context)";
  }

  const lines: string[] = [];
  const sleepLabel = r.sleepStatus ?? "awake";
  lines.push(`abTARS™ ${r.instanceName} — ${sleepLabel} ${r.mood}`);
  lines.push(`  PID ${r.pid} (up ${formatUptime(r.uptimeMs)})`);

  // Watchdog
  if (r.watchdog.pid !== null) {
    lines.push(
      r.watchdog.alive
        ? `  Watchdog: PID ${r.watchdog.pid}`
        : "  Watchdog: not running (stale PID)",
    );
  } else {
    lines.push("  Watchdog: not detected");
  }

  lines.push(`  Security: ${r.securityMode}`);
  if (r.trustMode) lines.push("  Trust: (trusted)");

  // Body
  lines.push("", "Body:");

  // Platforms
  const platformEntries = PLATFORM_NAMES.filter(name => name in r.platformStates).map(
    name =>
      `${r.platformStates[name] ? "✓" : "✗"} ${name.charAt(0).toUpperCase() + name.slice(1)}`,
  );
  if (platformEntries.length > 0) {
    lines.push(`  ✓ platforms: ${platformEntries.join("  ")}`);
  }

  // Dashboard
  if (view.dashboard.port) {
    lines.push(`  ✓ dashboard: :${view.dashboard.port}`);
  } else {
    lines.push("  ○ dashboard: disabled");
  }

  // Heart
  lines.push("", "Heart:");
  const hbState = r.heartbeat.running ? "✓" : "✗";
  const lastTickStr =
    r.heartbeat.lastTickSecondsAgo !== null
      ? r.heartbeat.lastTickSecondsAgo < 60
        ? `${r.heartbeat.lastTickSecondsAgo}s ago`
        : `${Math.round(r.heartbeat.lastTickSecondsAgo / 60)}m ago`
      : "";
  lines.push(
    `  ${hbState} heartbeat: ${r.heartbeat.intervalSec}s${lastTickStr ? ` / ${lastTickStr}` : ""}`,
  );
  lines.push(`  ✓ internal tasks: ${r.heartbeat.internalTaskCount}`);

  // Brain
  lines.push("", "Brain:");
  const modelShort = r.transport.model.split("/").pop() ?? r.transport.model;
  const ctxStr = r.contextPercent !== null ? ` (${r.contextPercent}%)` : "";
  lines.push(`  ✓ model: ${modelShort}${ctxStr}`);
  lines.push(
    `  ✓ spin: ${r.activeSessions} active session${r.activeSessions !== 1 ? "s" : ""}`,
  );
  if (r.kanban) {
    lines.push(`  ✓ kanban: ${r.kanban.active}/${r.kanban.total}`);
  } else {
    lines.push("  ✗ kanban: not initialized");
  }
  lines.push(
    `  ${r.shaPolicyConfigured ? "✓" : "~"} SHA: ${r.shaPolicyConfigured ? "rules configured" : "no policy configured"}`,
  );
  lines.push(`  ✓ skills: ${r.skillsActive} active`);

  // Soul
  lines.push("", "Soul:");
  if (r.soulBundle) {
    const allPresent = r.soulBundle.available === r.soulBundle.total;
    lines.push(`  ${allPresent ? "✓" : "~"} memory: abmind working`);
    lines.push(`    soul bundle: ${r.soulBundle.available}/${r.soulBundle.total} available`);
  } else {
    lines.push("  ✗ memory: none");
  }

  // Tribe
  lines.push("", "Tribe:");
  lines.push(
    `  ${r.a2a.running ? "✓" : "○"} a2a${r.a2a.port !== null ? `: ${r.a2a.port} enabled` : ""}`,
  );
  if (r.peersConfigured > 0) {
    lines.push(`  ✓ peers: ${r.peersConfigured} configured`);
  } else {
    lines.push("  ○ peers: none configured");
  }
  if (r.gossip.configured) {
    const broadcast =
      r.gossip.lastBroadcastSecondsAgo !== null
        ? r.gossip.lastBroadcastSecondsAgo < 60
          ? `${r.gossip.lastBroadcastSecondsAgo}s ago`
          : `${Math.round(r.gossip.lastBroadcastSecondsAgo / 60)}m ago`
        : "no broadcast yet";
    lines.push(`  ✓ gossip: ${r.gossip.port} / last broadcast ${broadcast}`);
  } else {
    lines.push("  ○ gossip: disabled");
  }

  // Footer
  lines.push("");
  const tasksLine = `Tasks: ${r.tasks.recurring} recurring, ${r.tasks.pending} pending${r.tasks.paused ? `, ${r.tasks.paused} paused` : ""}`;
  lines.push(tasksLine);
  if (r.lastBackup) lines.push(`Last backup: ${r.lastBackup}`);

  return lines.join("\n");
}

// ── Private helpers ──────────────────────────────────────────────────────────

interface BridgeLockState {
  pid: number | null;
  startedAt: string | null;
  startedAtMs: number | null;
  startReason: string | null;
  lastHeartbeatMs: number | null;
  heartbeatStaleSeconds: number | null;
  alive: boolean;
  lockReadError: boolean;
}

function readBridgeLock(lockPath: string): BridgeLockState {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
    const pid = typeof lock["pid"] === "number" ? (lock["pid"] as number) : null;
    const startedAtMs =
      typeof lock["startedAt"] === "number" ? (lock["startedAt"] as number) : null;
    const startReason =
      typeof lock["startReason"] === "string" ? (lock["startReason"] as string) : null;
    const lastHeartbeatMs =
      typeof lock["lastHeartbeat"] === "number" ? (lock["lastHeartbeat"] as number) : null;

    const alive = pid !== null && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    return {
      pid,
      startedAt: startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
      startedAtMs,
      startReason,
      lastHeartbeatMs,
      heartbeatStaleSeconds:
        lastHeartbeatMs !== null
          ? Math.max(0, Math.round((Date.now() - lastHeartbeatMs) / 1000))
          : null,
      alive,
      lockReadError: false,
    };
  } catch {
    return {
      pid: null,
      startedAt: null,
      startedAtMs: null,
      startReason: null,
      lastHeartbeatMs: null,
      heartbeatStaleSeconds: null,
      alive: false,
      lockReadError: true,
    };
  }
}

function readPorts(envPath: string): { dashboardPort: number | null; agentApiPort: number | null } {
  try {
    const envContent = readFileSync(envPath, "utf-8");
    const w = envContent.match(/^WEB_PORT=(\d+)/m)?.[1];
    const a = envContent.match(/^AGENT_API_PORT=(\d+)/m)?.[1];
    return {
      dashboardPort: w ? parseInt(w, 10) : null,
      agentApiPort: a ? parseInt(a, 10) : null,
    };
  } catch {
    return { dashboardPort: null, agentApiPort: null };
  }
}

function detectScope(): "system" | "user" | null {
  if (existsSync("/etc/systemd/system/abtars.service")) return "system";
  const userUnit = join(
    process.env["HOME"] ?? "",
    ".config",
    "systemd",
    "user",
    "abtars-watchdog.service",
  );
  if (existsSync(userUnit)) return "user";
  return null;
}

function unitName(scope: "system" | "user"): string {
  return scope === "user" ? "abtars-watchdog" : "abtars";
}

function collectDaemon(
  installMode: string,
  bridgeStartedAtMs: number | null,
  bridgeStartReason: string | null,
  bridgeLastHeartbeatMs: number | null,
  warnings: string[],
): DaemonInfo | null {
  if (installMode === "simple") return null;

  const scope = detectScope();
  if (!scope) {
    warnings.push("daemon mode set but no systemd unit installed");
    return null;
  }

  const unit = unitName(scope);
  const r = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      return spawnSync(
        "systemctl",
        scope === "user" ? ["--user", "status", unit] : ["status", unit],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: SYSTEMCTL_TIMEOUT_MS },
      );
    } catch {
      return null;
    }
  })();

  const output = r?.stdout || r?.stderr || "";
  const activeRaw = output.match(/Active:\s+(.+)/)?.[1]?.trim() ?? "unknown";
  const pidMatch = output.match(/Main PID:\s+(\d+)/)?.[1];
  const mainPid = pidMatch ? parseInt(pidMatch, 10) : null;

  const heartbeatStaleSeconds =
    bridgeLastHeartbeatMs !== null
      ? Math.max(0, Math.round((Date.now() - bridgeLastHeartbeatMs) / 1000))
      : null;
  const bridgeUptimeSeconds =
    bridgeStartedAtMs !== null
      ? Math.max(0, Math.round((Date.now() - bridgeStartedAtMs) / 1000))
      : null;

  return {
    scope,
    unit,
    active: activeRaw,
    mainPid,
    bridgeUptimeSeconds,
    startReason: bridgeStartReason,
    heartbeatStaleSeconds,
  };
}

function collectTui(branch: string | null, bridgePid: number | null): TuiInfo {
  // TUI_ENABLED from .env (read by readPorts path-adjacent, but kept inline for clarity)
  let tuiEnabled = false;
  try {
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const envPath = join(abtarsHome(), "config", ".env");
    const envContent = readFileSync(envPath, "utf-8");
    tuiEnabled = /^TUI_ENABLED=(true|1)$/m.test(envContent);
  } catch {}

  const onTuiBranch = branch !== null && /tui/i.test(branch);
  const present = tuiEnabled && onTuiBranch;

  // Bridge tty from /proc/<pid>/stat field 7
  let bridgeTty = "—";
  if (bridgePid) {
    try {
      const stat = readFileSync(`/proc/${bridgePid}/stat`, "utf-8");
      // /proc/[pid]/stat format: pid (comm) state ppid pgrp session tty_nr ...
      // comm can contain spaces and parens — split on the LAST ")" to skip it.
      // After that: [0]=state [1]=ppid [2]=pgrp [3]=session [4]=tty_nr.
      const ttyNr = stat.split(")").pop()!.trim().split(/\s+/)[4];
      bridgeTty = ttyNr === "0" ? "none" : `tty${ttyNr}`;
    } catch {
      bridgeTty = "?";
    }
  }

  return {
    present,
    enabled: tuiEnabled,
    onTuiBranch,
    bridgeTty,
    clientsAttached: 0, // stub: future #1315 writes ~/.abtars/tui/clients.json
  };
}

async function collectRuntime(ctx: BridgeStatusCtx, warnings: string[]): Promise<RuntimeView> {
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
  } catch (err) {
    logAndSwallow("status", "transport", err);
  }

  // Transport readiness from ctx
  const transportReady = ctx.transport?.isReady ?? false;

  // Sleep status from bridge.lock
  let sleepStatus = "awake";
  try {
    const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8")) as Record<string, unknown>;
    if (typeof lock["sleepStatus"] === "string") sleepStatus = lock["sleepStatus"] as string;
  } catch {}

  // Watchdog
  const wdPidEnv = process.env["ABTARS_WATCHDOG_PID"];
  const watchdog = (() => {
    if (!wdPidEnv || wdPidEnv === "0") return { pid: null, alive: false };
    const pid = Number(wdPidEnv);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    return { pid, alive };
  })();

  // Security + trust
  let securityMode = "off";
  let trustMode = false;
  try {
    const { getSecurityMode } = await import("./guardrails.js");
    const { getEnv } = await import("./env-schema.js");
    securityMode = getSecurityMode();
    trustMode = (getEnv() as { trustMode?: boolean }).trustMode === true;
  } catch (err) {
    logAndSwallow("status", "trust", err);
  }

  // Platform running states
  const platformStates: Record<string, boolean> = {};
  try {
    const serviceStates = ctx.registry.getStates();
    for (const name of PLATFORM_NAMES) {
      const svc = serviceStates[name];
      if (svc) platformStates[name] = svc.running;
    }
  } catch (err) {
    logAndSwallow("status", "platforms", err);
  }

  // A2A port + running state
  const a2aPort = (() => {
    const v = process.env["AGENT_API_PORT"];
    return v ? parseInt(v, 10) : null;
  })();
  const a2a: RuntimeView["a2a"] = {
    running: (() => {
      try {
        return ctx.registry.getStates()["agent-api"]?.running ?? false;
      } catch {
        return false;
      }
    })(),
    port: a2aPort,
  };

  // Heartbeat — interval from ctx, live state from HeartbeatSystem singleton
  let hbRunning = false;
  let hbInternalTaskCount = 0;
  try {
    const { getHeartbeatInstance } = await import("./heartbeat-system.js");
    const hb = getHeartbeatInstance();
    if (hb) {
      hbRunning = hb.isRunning;
      hbInternalTaskCount = hb.getTaskNames().length;
    }
  } catch {}
  const heartbeat: RuntimeView["heartbeat"] = {
    running: hbRunning,
    intervalSec: Math.round(ctx.heartbeatIntervalMs / 1000),
    lastTickSecondsAgo: (() => {
      try {
        const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8")) as Record<string, unknown>;
        if (typeof lock["lastHeartbeat"] === "number") {
          return Math.max(0, Math.round((Date.now() - (lock["lastHeartbeat"] as number)) / 1000));
        }
      } catch {}
      return null;
    })(),
    internalTaskCount: hbInternalTaskCount,
  };

  // Active Spin sessions
  let activeSessions = 0;
  try {
    const { spin } = await import("./spin.js");
    activeSessions = spin.listAllSessions().length;
  } catch (err) {
    logAndSwallow("status", "spin", err);
  }

  // Kanban
  let kanban: RuntimeView["kanban"] = null;
  try {
    const { kanbanList } = await import("./tasks/kanban-board.js");
    const all = kanbanList() as Array<{ status: string }>;
    const active = all.filter(c => ["queued", "running", "delivering"].includes(c.status)).length;
    kanban = { active, total: all.length };
  } catch (err) {
    logAndSwallow("status", "kanban", err);
  }

  // SHA policy
  let shaPolicyConfigured = false;
  try {
    const { abtarsHome } = await import("../paths.js");
    shaPolicyConfigured = existsSync(join(abtarsHome(), "config", "sha-policy.json"));
  } catch {}

  // Skills
  let skillsActive = 0;
  try {
    const { getSkillCache } = await import("../capabilities/hotskills/index.js");
    const skills = getSkillCache() as unknown as Array<{ skipped?: boolean }>;
    skillsActive = skills.filter(s => !s.skipped).length;
  } catch {}

  // Soul bundle
  let soulBundle: RuntimeView["soulBundle"] = null;
  try {
    const { getEnv } = await import("./env-schema.js");
    const { abmindHome } = await import("../paths.js");
    const memoryProvider =
      (getEnv() as { memory?: string }).memory ?? "abmind";
    if (memoryProvider === "abmind" || memoryProvider === "auto") {
      const coreDir = join(abmindHome(), "memory", "core");
      if (existsSync(coreDir)) {
        const available = SOUL_CORE_FILES.filter(f => existsSync(join(coreDir, f))).length;
        soulBundle = { available, total: SOUL_CORE_FILES.length };
      }
    }
  } catch (err) {
    logAndSwallow("status", "soul", err);
  }

  // Peers configured
  let peersConfigured = 0;
  try {
    const { abtarsHome } = await import("../paths.js");
    const peersPath = join(abtarsHome(), "config", "peers.json");
    if (existsSync(peersPath)) {
      const peers = JSON.parse(readFileSync(peersPath, "utf-8")) as Record<string, unknown>;
      peersConfigured = Object.keys(peers).filter(k => k !== "self").length;
    }
  } catch (err) {
    logAndSwallow("status", "peers", err);
  }

  // Gossip
  const gossip: RuntimeView["gossip"] = {
    configured: peersConfigured > 0,
    port: (() => {
      const v = process.env["GOSSIP_PORT"];
      return v ? parseInt(v, 10) : 5355;
    })(),
    lastBroadcastSecondsAgo: (() => {
      try {
        const lock = JSON.parse(readFileSync(ctx.bridgeLockPath, "utf-8")) as Record<string, unknown>;
        if (typeof lock["lastGossipBroadcast"] === "number") {
          return Math.max(0, Math.round((Date.now() - (lock["lastGossipBroadcast"] as number)) / 1000));
        }
      } catch {}
      return null;
    })(),
  };

  // Tasks
  let tasks: RuntimeView["tasks"] = { recurring: 0, pending: 0, paused: 0 };
  try {
    const { readEntries } = await import("./tasks/task-store.js");
    const entries = readEntries() as Array<{ schedule?: unknown; fired?: boolean; paused?: boolean }>;
    tasks = {
      recurring: entries.filter(e => e.schedule && !e.paused).length,
      pending: entries.filter(e => !e.fired && !e.schedule).length,
      paused: entries.filter(e => e.paused).length,
    };
  } catch (err) {
    logAndSwallow("status", "tasks", err);
  }

  // Last backup
  let lastBackup: string | null = null;
  try {
    const { readdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const bd = join(homedir(), ".backup-abtars");
    const bk = readdirSync(bd)
      .filter((f: string) => f.startsWith("abtars-") && (f.endsWith(".zip") || f.endsWith(".7z")))
      .sort();
    if (bk.length > 0) lastBackup = bk[bk.length - 1] ?? null;
  } catch (err) {
    logAndSwallow("status", "backup", err);
  }

  // Mood: derived from warnings + runtime failure signals
  const runtimeFailureCount = countRuntimeFailures(ctx, platformStates, a2a.running);
  const totalFailures = warnings.length + runtimeFailureCount;
  const mood: RuntimeView["mood"] =
    totalFailures === 0 ? "😊" : totalFailures <= 2 ? "😐" : "😟";

  if (totalFailures > 0) {
    // Don't double-warn for runtime issues that already appear in platformStates/a2a
    void warnings;
  }

  return {
    instanceName: getInstanceName(),
    sleepStatus,
    mood,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
    watchdog,
    securityMode,
    trustMode,
    transport: {
      ready: transportReady,
      type: transportType,
      provider: transportProvider,
      model,
    },
    contextPercent: ctx.transport?.contextPercent ?? null,
    platformStates,
    heartbeat,
    activeSessions,
    kanban,
    shaPolicyConfigured,
    skillsActive,
    soulBundle,
    a2a,
    peersConfigured,
    gossip,
    tasks,
    lastBackup,
  };
}

function countRuntimeFailures(
  ctx: BridgeStatusCtx,
  platformStates: Record<string, boolean>,
  a2aRunning: boolean,
): number {
  let n = 0;
  for (const [, health] of ctx.phaseHealth) {
    if (health.status === "failed") n++;
  }
  try {
    const states = ctx.registry.getStates();
    for (const svc of Object.values(states)) {
      if (svc.retrying) n++;
    }
  } catch {}
  for (const [, running] of Object.entries(platformStates)) {
    if (!running) n++;
  }
  if (!a2aRunning) n++;
  return n;
}

function stateIcon(active: string): string {
  const word = active.split(/\s+/)[0] ?? "";
  if (word === "active") return "●";
  if (word === "inactive" || word === "deactivating") return "○";
  if (word === "failed") return "✗";
  if (word === "activating") return "◐";
  return "○";
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
