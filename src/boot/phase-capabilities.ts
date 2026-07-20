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

import { logInfo, logWarn, logError, logDebug } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";

export async function phaseCapabilities(ctx: BootCtx): Promise<PhaseResult> {
  const { config, transport, runtime, capabilities, pipelineDeps } = ctx;

  // Skills catalog: pure filesystem, no deps — always generate (#996)
  try {
    const { SkillWatcher } = await import("../components/skill-watcher.js");
    const { abtarsHome } = await import("../paths.js");
    const { join } = await import("node:path");
    const sw = new SkillWatcher(join(abtarsHome(), "skills"), join(abtarsHome(), "skills", "skills_catalog.md"));
    sw.generateCatalog();
  } catch {}

  if (!transport || !pipelineDeps) { ctx.phaseHealth.set(phaseCapabilities.name, { status: "skipped", error: "no transport" }); logWarn("boot", `${phaseCapabilities.name}: skipping — transport not available`); return "skipped"; }

  const { createCapabilityApi } = await import("../capabilities/capability.js");
  const { getEnv } = await import("../components/env-schema.js");
  const disabled = new Set(getEnv().disabledCapabilities.split(",").map(s => s.trim()).filter(Boolean));
  let loaded: string[] = [];

  // Load capabilities individually — one failing must not kill others (#580)
  let staticCaps: Array<{ name: string; module: { register: (api: any) => void } }>;
  try {
    ({ capabilities: staticCaps } = await import("../capabilities/_registry.generated.js"));
  } catch (err) {
    // Registry chunk failed (missing runtime dep). Load each independently.
    logError("capabilities", `Registry import failed: ${err instanceof Error ? err.message : String(err)}. Loading individually.`);
    staticCaps = [];
    const individualCaps = [
      { name: "hotskills", load: () => import("../capabilities/hotskills/index.js") },
      { name: "browser", load: () => import("../capabilities/browser/index.js") },
    ];
    for (const { name, load } of individualCaps) {
      if (disabled.has(name)) continue;
      try {
        const { shouldAttempt } = await import("../components/sha-tracker.js");
        if (!shouldAttempt("missing-dep", name)) { logDebug("capabilities", `Skipped "${name}": SHA cooldown active`); continue; }
        const mod = await load();
        staticCaps.push({ name, module: mod });
      } catch (e) {
        const { recordResult } = await import("../components/sha-tracker.js");
        recordResult("missing-dep", name, false, e instanceof Error ? e.message : String(e));
        logWarn("capabilities", `Skipped "${name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  for (const cap of staticCaps) {
    if (disabled.has(cap.name)) continue;
    try {
      const api = createCapabilityApi(capabilities, config, ctx.memoryRuntime, transport, runtime, ctx.sessionManager, ctx.sendSystemMessage);
      cap.module.register(api);
      loaded.push(cap.name);
    } catch (err) {
      logWarn("capabilities", `Failed to load "${cap.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ctx.capabilitiesLoaded = loaded;
  if (loaded.length > 0) {
    logInfo("main", `🔌 Capabilities: ${loaded.join(", ")}`);
    pipelineDeps.loadedCapabilities = loaded;
  }

  // MCP daemon — starts on-demand via mcp tool or /mcp start (#471 v2)
  return "ran";
}
