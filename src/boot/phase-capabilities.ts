/**
 * phase-capabilities — boot phase 7: auto-discover capabilities + start MCP daemon.
 *
 * - Discovers capabilities from dist/boot/../capabilities (browser, hotskills, etc.)
 * - Appends loaded capability names to ctx.pipelineDeps.loadedCapabilities
 * - Starts mcporter daemon if configured
 *
 * Populates ctx: capabilitiesLoaded, mcpDaemonStarted.
 * Mutates pipelineDeps.loadedCapabilities in place (closure seen by message-pipeline).
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx } from "./context.js";

export async function phaseCapabilities(ctx: BootCtx): Promise<void> {
  const { config, memory, transport, runtime, capabilities, pipelineDeps } = ctx;
  if (!transport || !pipelineDeps) throw new Error("phase-capabilities: transport + pipeline-deps required");

  const { discoverCapabilities } = await import("../capabilities/capability.js");
  // From dist/boot/phase-capabilities.js: "../capabilities" resolves to dist/capabilities
  const capDir = join(import.meta.dirname, "..", "capabilities");
  const loaded = await discoverCapabilities(capabilities, config, memory, transport, runtime, capDir);
  ctx.capabilitiesLoaded = loaded;
  if (loaded.length > 0) {
    logInfo("main", `🔌 Capabilities: ${loaded.join(", ")}`);
    pipelineDeps.loadedCapabilities = ["sleep", ...loaded];
  }

  // MCP daemon
  if (config.mcpDaemon) {
    try {
      execFileSync("mcporter", ["daemon", "start"], { stdio: "pipe" });
      ctx.mcpDaemonStarted = true;
      logInfo("main", "🔌 mcporter daemon started");
    } catch {
      logWarn("main", "mcporter not found or daemon start failed — skipping");
    }
  }
}
