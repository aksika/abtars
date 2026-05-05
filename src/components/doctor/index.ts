/**
 * doctor — deep runtime healthcheck. Probes every subsystem in parallel.
 * Shared cache (60s) prevents token-burning spam.
 */

import { logInfo } from "../logger.js";

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
  memory?: { getStats: () => any; getCronInfo: () => any } | null;
  transport?: { sendPrompt: (key: string, msg: string) => Promise<string> } | null;
  telegramRunning?: boolean;
  discordRunning?: boolean;
  config?: { webPort?: number } | null;
  phaseHealth?: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
}

type ProbeFn = (ctx: DoctorCtx) => Promise<ProbeResult>;

function withTimeout(probe: ProbeFn, timeoutMs: number): ProbeFn {
  return async (ctx) => {
    const start = Date.now();
    try {
      const result = await Promise.race([
        probe(ctx),
        new Promise<ProbeResult>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      return result;
    } catch (err) {
      return { name: "unknown", status: "failed", latencyMs: Date.now() - start, detail: `timeout after ${timeoutMs}ms` };
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

const probeHeartbeat: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.memory) return { name: "heartbeat", status: "skipped", latencyMs: 0 };
  try {
    const info = ctx.memory.getCronInfo();
    const running = info.heartbeatRunning;
    return { name: "heartbeat", status: running ? "ok" : "failed", latencyMs: Date.now() - start, detail: running ? `interval ${info.intervalMs}ms` : "not running" };
  } catch {
    return { name: "heartbeat", status: "failed", latencyMs: Date.now() - start };
  }
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
  } catch {
    return { name: "dashboard", status: "skipped", latencyMs: Date.now() - start, detail: "not running" };
  }
};

const probeOllama: ProbeFn = async (_ctx) => {
  const start = Date.now();
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    return { name: "ollama", status: res.ok ? "ok" : "failed", latencyMs: Date.now() - start };
  } catch {
    return { name: "ollama", status: "skipped", latencyMs: Date.now() - start, detail: "not reachable" };
  }
};

const probeCoreFiles: ProbeFn = async (_ctx) => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const start = Date.now();
  const memDir = process.env["ABMIND_MEMORY_DIR"] || join(homedir(), ".abmind", "memory");
  const abmindCore = join(memDir, "core");
  const required = ["SOUL.md", "user_profile.md", "agent_notes.md", "memory-tools.md", "core_facts.md"];
  const missing = required.filter(f => !existsSync(join(abmindCore, f)));
  if (missing.length === 0) return { name: "core-files", status: "ok", latencyMs: Date.now() - start };
  return { name: "core-files", status: "failed", latencyMs: Date.now() - start, detail: `missing: ${missing.join(", ")}` };
};

// ── Collector ────────────────────────────────────────────────────────────────

const PROBES: Array<{ fn: ProbeFn; timeout: number }> = [
  { fn: probeCoreFiles, timeout: 1000 },
  { fn: probeMemory, timeout: 5000 },
  { fn: probeTelegram, timeout: 5000 },
  { fn: probeDiscord, timeout: 5000 },
  { fn: probeHeartbeat, timeout: 2000 },
  { fn: probeDashboard, timeout: 5000 },
  { fn: probeOllama, timeout: 5000 },
  { fn: probeTransport, timeout: 10000 }, // last — most expensive
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
    PROBES.map(p => withTimeout(p.fn, p.timeout)(ctx).then(r => {
      // withTimeout may return name="unknown" — fix it
      if (r.name === "unknown") r.name = "probe";
      return r;
    }))
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
  const icon = (s: ProbeResult["status"]): string => s === "ok" ? "✓" : s === "failed" ? "✗" : "⏭";
  const lines = report.results.map(r => {
    const detail = r.detail ? ` — ${r.detail}` : "";
    const ms = r.latencyMs > 0 ? ` (${r.latencyMs}ms)` : "";
    return `  ${icon(r.status)} ${r.name}${ms}${detail}`;
  });
  const tag = report.cached ? `[cached ${Math.round((report.cacheAgeMs ?? 0) / 1000)}s ago]` : "[fresh]";
  return `🩺 Doctor Report (${(report.totalMs / 1000).toFixed(1)}s)  ${tag}\n${lines.join("\n")}`;
}
