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
  telegramAdapter?: { api?: { getMe?: () => Promise<any> } } | null;
  discordAdapter?: { client?: { ws?: { ping?: number } } } | null;
  config?: { webPort?: number } | null;
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
  if (!ctx.telegramAdapter) return { name: "telegram", status: "skipped", latencyMs: 0, detail: "not running" };
  try {
    await (ctx.telegramAdapter as any).api?.getMe?.();
    return { name: "telegram", status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { name: "telegram", status: "failed", latencyMs: Date.now() - start, detail: String(err) };
  }
};

const probeDiscord: ProbeFn = async (ctx) => {
  const start = Date.now();
  if (!ctx.discordAdapter) return { name: "discord", status: "skipped", latencyMs: 0, detail: "not running" };
  try {
    const ping = (ctx.discordAdapter as any).client?.ws?.ping;
    return { name: "discord", status: "ok", latencyMs: Date.now() - start, detail: ping != null ? `ws ping ${ping}ms` : undefined };
  } catch (err) {
    return { name: "discord", status: "failed", latencyMs: Date.now() - start, detail: String(err) };
  }
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

// ── Collector ────────────────────────────────────────────────────────────────

const PROBES: Array<{ fn: ProbeFn; timeout: number }> = [
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
