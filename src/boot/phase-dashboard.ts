/**
 * phase-dashboard — boot phase 11: initialize web dashboard (if --web).
 *
 * - No-op if ctx.platforms.web is false
 * - Loads + validates dashboard config (exits on failure)
 * - Loads logo (optional)
 * - Constructs DashboardServer (or DASHBOARD_MODULE-pluggable) + AuthGate
 *   + MemorySearchController + getStatus snapshot closure
 * - Starts server
 *
 * Populates ctx: dashboardServer.
 *
 * No singletons owned.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logError } from "../components/logger.js";
import { loadDashboardConfig, validateDashboardConfig, buildStatusSnapshot } from "../components/dashboard/dashboard-config.js";
import type { SubsystemRefs } from "../components/dashboard/dashboard-config.js";
import { AuthGate } from "../components/auth-gate.js";
import { MemorySearchController } from "../components/memory-search-controller.js";
import { DashboardServer } from "../components/dashboard/dashboard-server.js";
import { renderDashboardHtml } from "../components/dashboard/dashboard-ui.js";
import { loadAgentApiConfig } from "../components/agent-api-config.js";
import type { IDashboardSlot, DashboardSlotOpts } from "../components/skeleton.js";
import type { BootCtx } from "./context.js";

export async function phaseDashboard(ctx: BootCtx): Promise<void> {
  const { platforms, config, memory, transport, registry, heartbeat, nlmConfig } = ctx;
  if (!platforms.web) return;
  if (!transport || !heartbeat) throw new Error("phase-dashboard: transport + heartbeat required");

  const dashConfig = loadDashboardConfig(process.env);
  try {
    validateDashboardConfig(dashConfig, true);
  } catch (err) {
    logError("main", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let logoBase64 = "";
  try {
    const logoPath = join(process.cwd(), "logo", "KiroProfessor.jpg");
    logoBase64 = readFileSync(logoPath).toString("base64");
  } catch {
    // Logo is optional
  }

  const agentApiOpts = platforms.agent
    ? (() => { try { return loadAgentApiConfig(process.env as Record<string, string | undefined>); } catch { return undefined; } })()
    : undefined;
  const dashboardHtml = renderDashboardHtml(
    logoBase64,
    agentApiOpts ? { agentApi: { port: agentApiOpts.port, allowedIps: agentApiOpts.allowedIps } } : undefined,
  );

  const getStatus = (): ReturnType<typeof buildStatusSnapshot> => {
    const svcStates = registry.getStates();
    const refs: SubsystemRefs = {
      startedAt: ctx.startedAt,
      telegramPoller: { running: svcStates.telegram?.running ?? false },
      discordPoller: { started: svcStates.discord?.running ?? false },
      services: svcStates,
      transport: {
        type: config.transport.agentTransport as "tmux" | "acp" | "api",
        isReady: transport.isReady,
        contextPercent: transport.contextPercent,
      },
      memory: memory ? { getStats: (userId?: string) => memory.getStats(userId) } : null,
      heartbeat: memory
        ? { running: memory.getStats()?.heartbeatRunning ?? false, intervalMs: heartbeat.intervalMs, tasks: heartbeat.getTaskNames().map(n => ({ name: n })) }
        : null,
      notebooklm: nlmConfig.enabled,
      agentApi: ctx.agentApiServer ? { getTrafficLog: () => ctx.agentApiServer!.getTrafficLog() } : null,
    };
    return buildStatusSnapshot(refs);
  };

  const authGate = new AuthGate(dashConfig.webAuthToken);
  const memorySearchController = memory ? new MemorySearchController({ memory }) : null;

  const customModule = process.env["DASHBOARD_MODULE"];
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
      dashboardHtml,
    });
  }

  await dashboardServer.start();
  ctx.dashboardServer = dashboardServer;
  logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort}${customModule ? ` (custom: ${customModule})` : ""}`);
}
