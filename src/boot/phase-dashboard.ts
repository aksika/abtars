import { logAndSwallow } from "../components/log-and-swallow.js";
import { getEnv } from "../components/env-schema.js";
/**
 * phase-dashboard — boot phase 11: initialize web dashboard (if --web).
 *
 * - No-op if ctx.platforms.web is false
 * - Loads + validates dashboard config (exits on failure)
 * - Constructs DashboardServer (or DASHBOARD_MODULE-pluggable) + AuthGate
 *   + MemorySearchController + getStatus snapshot closure
 * - Starts server (serves static frontend from public/)
 *
 * Populates ctx: dashboardServer.
 *
 * No singletons owned.
 */

import { join } from "node:path";
import { logInfo, logWarn } from "../components/logger.js";
import { loadDashboardConfig, buildStatusSnapshot } from "../components/dashboard/dashboard-config.js";
import type { SubsystemRefs } from "../components/dashboard/dashboard-config.js";
import { AuthGate } from "../components/auth-gate.js";
import { MemorySearchController } from "../components/memory-search-controller.js";
import { DashboardServer } from "../components/dashboard/dashboard-server.js";
import { loadAgentApiConfig } from "../components/agent-api-config.js";
import type { IDashboardSlot, DashboardSlotOpts } from "../components/skeleton.js";
import type { BootCtx, PhaseResult } from "./context.js";

const TAG = "dashboard";

export async function phaseDashboard(ctx: BootCtx): Promise<PhaseResult> {
  const { platforms, memory, transport, registry, heartbeat, nlmConfig } = ctx;
  if (!platforms.web) return "skipped";
  if (!transport || !heartbeat) { ctx.phaseHealth.set(phaseDashboard.name, { status: "skipped", error: "no transport/heartbeat" }); logWarn("boot", `${phaseDashboard.name}: skipping — deps not available`); return "skipped"; }

  const dashConfig = loadDashboardConfig(process.env);
  // Auto-generate WEB_AUTH_TOKEN if missing — persist to .env so it survives restart
  if (!dashConfig.webAuthToken) {
    const { randomBytes } = await import("node:crypto");
    const { readFile, writeFile } = await import("node:fs/promises");
    const token = randomBytes(32).toString("hex");
    dashConfig.webAuthToken = token;
    process.env["WEB_AUTH_TOKEN"] = token;
    const envPath = join(process.cwd(), "config", ".env");
    try {
      let content = "";
      try { content = await readFile(envPath, "utf-8"); } catch (err) { logAndSwallow("phase_dashboard", "op", err); }
      content = content.replace(/^WEB_AUTH_TOKEN=.*$/m, "").trimEnd();
      content += `\nWEB_AUTH_TOKEN=${token}\n`;
      await writeFile(envPath, content, { mode: 0o600 });
      logInfo("dashboard", `🔑 WEB_AUTH_TOKEN auto-generated and saved to ${envPath}`);
    } catch (err) {
      logInfo("dashboard", `🔑 WEB_AUTH_TOKEN auto-generated (not persisted: ${err instanceof Error ? err.message : String(err)})`);
    }
    logInfo("dashboard", `🔑 WEB_AUTH_TOKEN: ${token}`);
  } else {
    logInfo("dashboard", `🔑 WEB_AUTH_TOKEN: ${dashConfig.webAuthToken}`);
  }

  const agentApiOpts = platforms.agent
    ? (() => { try { return loadAgentApiConfig(process.env as Record<string, string | undefined>); } catch (err) { logAndSwallow(TAG, "loadAgentApiConfig", err); return null; } })()
    : null;

  const getStatus = (): ReturnType<typeof buildStatusSnapshot> => {
    const svcStates = registry.getStates();

    // Subsystem health from phaseHealth
    const subsystems = [...ctx.phaseHealth.entries()].map(([name, h]) => ({
      name: name.replace("phase", "").replace(/([A-Z])/g, " $1").trim(),
      status: h.status as "ok" | "failed" | "skipped",
      ...(h.error ? { detail: h.error } : {}),
    }));

    const refs: SubsystemRefs = {
      startedAt: ctx.startedAt,
      telegramPoller: { running: svcStates.telegram?.running ?? false },
      discordPoller: { started: svcStates.discord?.running ?? false },
      services: svcStates,
      transport: {
        type: (transport as any).transportType ?? "api" as "tmux" | "acp" | "api",
        isReady: transport.isReady,
        contextPercent: transport.contextPercent,
      },
      memory: memory ? { getStats: (userId?: string) => memory.getStats(userId) } : null,
      heartbeat: memory
        ? { running: memory.getStats()?.heartbeatRunning ?? false, intervalMs: heartbeat.intervalMs, tasks: heartbeat.getTaskNames().map(n => ({ name: n })) }
        : null,
      notebooklm: nlmConfig.enabled,
      agentApi: ctx.agentApiServer ? { getTrafficLog: () => ctx.agentApiServer!.getTrafficLog() } : null,
      version: ctx.version ?? "?",
      commit: ctx.commit ?? "?",
      model: { name: ctx.modelName ?? "unknown", provider: ctx.modelProvider ?? "unknown", fallbackChain: ctx.fallbackChain ?? [] },
      subsystems,
    };
    return buildStatusSnapshot(refs);
  };

  const authGate = new AuthGate(dashConfig.webAuthToken);
  const memorySearchController = memory ? new MemorySearchController({ memory }) : null;

  const customModule = getEnv().dashboardModule;
  let dashboardServer: IDashboardSlot;
  if (customModule) {
    const mod = await import(customModule);
    const Ctor = mod.Dashboard ?? mod.default;
    if (typeof Ctor?.prototype?.start !== "function" || typeof Ctor?.prototype?.stop !== "function") {
      throw new Error(`DASHBOARD_MODULE (${customModule}) does not implement IDashboardSlot (missing start/stop)`);
    }
    const opts: DashboardSlotOpts = { getStatus, port: dashConfig.webPort, host: dashConfig.webHost, authToken: dashConfig.webAuthToken };
    dashboardServer = new Ctor(opts) as IDashboardSlot;
  } else {
    dashboardServer = new DashboardServer({
      config: dashConfig,
      authGate,
      getStatus,
      registry,
      memorySearchController,
      agentApiConfig: agentApiOpts ? { port: agentApiOpts.port } : null,
    });
  }

  await dashboardServer.start();
  ctx.dashboardServer = dashboardServer;
  logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort}${customModule ? ` (custom: ${customModule})` : ""}`);
  return "ran";
}
