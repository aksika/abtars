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

import { join } from "node:path";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";

export async function phaseCapabilities(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memory, transport, runtime, capabilities, pipelineDeps } = ctx;
  if (!transport || !pipelineDeps) { ctx.phaseHealth.set(phaseCapabilities.name, { status: "skipped", error: "no transport" }); logWarn("boot", `${phaseCapabilities.name}: skipping — transport not available`); return "skipped"; }

  const { discoverCapabilities, createCapabilityApi } = await import("../capabilities/capability.js");
  // In bundle mode, directory scanning fails (no subdirs). Use static registry.
  let loaded: string[];
  try {
    const { capabilities: staticCaps } = await import("../capabilities/_registry.generated.js");
    const disabled = new Set((process.env["DISABLED_CAPABILITIES"] ?? "").split(",").map(s => s.trim()).filter(Boolean));
    loaded = [];
    for (const cap of staticCaps) {
      if (disabled.has(cap.name)) continue;
      try {
        const api = createCapabilityApi(capabilities, config, memory, transport, runtime, ctx.sessionManager);
        cap.module.register(api);
        loaded.push(cap.name);
      } catch (err) {
        logWarn("capabilities", `Failed to load "${cap.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Fallback to directory scanning (non-bundled / dev mode)
    const capDir = join(import.meta.dirname, "..", "capabilities");
    loaded = await discoverCapabilities(capabilities, config, memory, transport, runtime, capDir);
  }
  ctx.capabilitiesLoaded = loaded;
  if (loaded.length > 0) {
    logInfo("main", `🔌 Capabilities: ${loaded.join(", ")}`);
    pipelineDeps.loadedCapabilities = ["sleep", ...loaded];
  }

  // MCP daemon — starts on-demand via mcp tool or /mcp start (#471 v2)
  return "ran";
}
