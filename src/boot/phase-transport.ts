import { logAndSwallow } from "../components/log-and-swallow.js";
import { getEnv } from "../components/env-schema.js";
/**
 * phase-transport — boot phase 3: select, initialize, and wrap the agent transport.
 *
 * Also exports buildTransport/rebuildTransport for /reset to pick up transport.json changes
 * (including provider switches that can't be live-patched).
 */

import { execSync } from "node:child_process";
import { TmuxClient } from "../components/transport/tmux-client.js";
import { createAgentTransport } from "../components/agent-registry.js";
import { logDebug, logInfo, logWarn, logError } from "../components/logger.js";
import { loadUsers } from "../components/user-registry.js";
import { updateCtxStart } from "./ctx-start.js";
import { abmind } from "../utils/abmind-lazy.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";

const TAG = "transport";

export async function phaseTransport(ctx: BootCtx): Promise<PhaseResult> {
  const { memoryConfig } = ctx;

  // #1311 C8: warm pi-ai's catalog before buildTransport() resolves agents — resolveAgent is a
  // sync hot path that reads the warmed cache. Skipped entirely when no provider opts in.
  const { anyProviderUseProviderLib } = await import("../components/transport-config.js");
  if (anyProviderUseProviderLib()) {
    const { loadPiModels } = await import("../components/transport/pi-catalog.js");
    await loadPiModels();
  }

  await buildTransport(ctx);

  // Docker detection (#478)
  const { isDockerActive, isSeatbeltActive } = await import("../components/guardrails.js");
  if (isDockerActive()) {
    const { dockerAvailable } = await import("../components/sandbox-runtime.js");
    if (dockerAvailable()) {
      ctx.sandboxEnabled = true;
      logInfo("main", "🐳 Docker mode active — W/B/C sessions will run in Docker containers");
    } else {
      logWarn("main", "SECURITY_MODE=docker but Docker not available — falling back to seatbelt");
    }
  }

  // Seatbelt detection (#906)
  if (isSeatbeltActive()) {
    const { isAvailable, mechanismName } = await import("../components/seatbelt/index.js");
    if (isAvailable()) {
      ctx.seatbeltActive = true;
      logInfo("main", `🛡️ Seatbelt active — bash commands sandboxed via ${mechanismName()}`);
    } else {
      logWarn("main", `SECURITY_MODE=seatbelt but ${mechanismName()} not available — falling back to guardrails`);
    }
  }

  // Initialize context-window-start for all known users
  if (memoryConfig.memoryEnabled) {
    const reg = loadUsers();
    for (const user of reg.users) updateCtxStart(memoryConfig.memoryDir, user.userId, ctx.startedAt);
  }
  return "ran";
}

/**
 * Construct professor transport from current transport.json + env and attach to ctx.transport.
 * Idempotent: destroys any existing ctx.transport first.
 *
 * #367 — Validates the resolved provider BEFORE destroying the old transport.
 * If validation fails:
 *   - During `/reset` (old transport exists): logs ERROR, keeps the old transport up
 *   - At boot (no old transport): falls back to .env config if possible, or throws
 *   - In either case: bridge stays alive in degraded mode rather than crash-looping
 */
export async function buildTransport(ctx: BootCtx): Promise<PhaseResult> {
  const { config } = ctx;

  let transport: IKiroTransport;

  const { resolveAgent, getEnvFallback, loadTransport, resolveHailMary, clearTransportCache, validateProviderReady } = await import("../components/transport-config.js");
  const { existsSync, renameSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  clearTransportCache();  // always re-read (picks up /models change writes)
  let tc = loadTransport();

  // Recovery: if transport.json missing/corrupt, try transport.old.json
  if (!tc) {
    const configDir = pathJoin(getEnv().abtarsHome, "config");
    const primary = pathJoin(configDir, "transport.json");
    const old = pathJoin(configDir, "transport.old.json");
    if (existsSync(old)) {
      logDebug("main", "transport.json missing/corrupt — recovering from transport.old.json");
      renameSync(old, primary);
      clearTransportCache();
      tc = loadTransport();
    }
  }

  const prof = tc ? resolveAgent("professor", tc) : null;

  const hm = resolveHailMary(tc);
  if (hm) {
    ctx.hailMary = {
      model: hm.model,
      endpoint: hm.endpoint,
      apiKey: hm.apiKeyEnv ? getEnv().getApiKey(hm.apiKeyEnv) : undefined,
    };
    logInfo("main", `🚨 hailMary configured: ${hm.model} (manual /model emergency only)`);
  } else {
    ctx.hailMary = null;
  }

  let resolved: typeof prof = null;

  if (!tc) {
    // No transport.json and no .old.json — emergency mode from .env
    const fb = getEnvFallback();
    const fbValidation = validateProviderReady(fb.providerName, fb.provider, getEnv());
    if (!fbValidation.ok) {
      logError("main", `No transport.json, no backup, and .env emergency model also invalid: ${fbValidation.reason}`);
      logWarn("main", "Transport unavailable — running in Tier 2 (no agent responses)");
      ctx.transport = null;
      return "skipped";
    }
    logWarn("main", `⚠️ No transport.json — emergency mode: ${fb.model} via ${fb.providerName}`);
    resolved = { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
    // Notify user (deferred — transport not yet built)
    setTimeout(() => {
      import("../components/notification.js").then(({ sendNotification }) =>
        sendNotification(ctx, `⚠️ transport.json missing, no backup. Running emergency model: ${fb.model}. Fix: /update deploy`))
        .catch(() => {});
    }, 10_000);
  } else {
    // transport.json valid — walk primary + fb chain
    const validation = validateProviderReady(prof!.providerName, prof!.provider, getEnv());
    if (validation.ok) {
      logDebug("main", `Model init OK: ${prof!.model} via ${prof!.providerName}`);
      resolved = prof;
    } else {
      logDebug("main", `Model init failed: ${prof!.model} — ${validation.reason}`);
      logWarn("main", `${prof!.model}: ${validation.reason} — trying fallbacks`);
      // Walk fallback chain
      for (const fb of prof!.fallbacks) {
        const fbResolved = resolveAgent("_fb", { ...tc!, agents: { ...tc!.agents, _fb: { model: fb.model, provider: fb.provider } } });
        if (!fbResolved) continue;
        const fbVal = validateProviderReady(fbResolved.providerName, fbResolved.provider, getEnv());
        if (fbVal.ok) {
          logDebug("main", `Fallback init OK: ${fbResolved.model} via ${fbResolved.providerName}`);
          resolved = fbResolved;
          break;
        }
        logDebug("main", `Fallback init failed: ${fbResolved.model} — ${fbVal.reason}`);
        logWarn("main", `${fbResolved.model}: ${fbVal.reason} — trying next`);
      }
    }

    if (!resolved) {
      // ALL configured models failed — hard error (boot) or keep existing (reset)
      const tried = [prof!.model, ...prof!.fallbacks.map(f => f.model)].join(", ");
      if (ctx.transport) {
        logError("main", `All models failed init (${tried}) — keeping existing transport up`);
        return "ran";
      }
      logError("main", `All configured models failed init (${tried}). Fix transport.json or use /emergency`);
      logWarn("main", "Transport unavailable — running in Tier 2 (no agent responses)");
      ctx.transport = null;
      return "skipped";
    }
  }

  // #367 — if existing transport is up and new config rebuild needed, keep old on error
  // (This path is only hit via /reset rebuild, not boot)

  // Destroy old (if any) — now that we know the new config is valid
  if (ctx.transport) {
    try { await ctx.transport.destroy(); } catch (err) {
      logWarn("main", `Old transport destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.transport = null;
  }

  if (resolved.provider.transport === "tmux") {
    const defaults = tc?.transportDefaults?.tmux;
    logInfo("main", `🖥️  tmux transport (${resolved.providerName})`);
    transport = new TmuxClient(
      defaults?.session ?? config.transport.tmuxSession,
      defaults?.captureDelaySec ?? config.transport.tmuxCaptureDelaySec,
      defaults?.maxWaitSec ?? config.transport.tmuxMaxWaitSec,
    );
  } else if (resolved.provider.transport === "api") {
    const { DirectApiTransport } = await import("../components/transport/direct-api-transport.js");
    const { ModelHealthRegistry } = await import("../components/transport/model-health-registry.js");
    const { FallbackPolicy } = await import("../components/transport/fallback-policy.js");
    const apiKey = getEnv().getApiKey(resolved.provider.apiKeyEnv ?? "API_KEY");

    const candidates: Array<{ model: string; endpoint: string; apiKey?: string; maxContext: number }> = [
      { endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1", apiKey, model: resolved.model, maxContext: resolved.contextWindow },
    ];
    for (const fb of resolved.fallbacks) {
      const fbResolved = tc ? resolveAgent("_fallback", { ...tc, agents: { ...tc.agents, _fallback: { model: fb.model, provider: fb.provider } } }) : null;
      candidates.push({
        endpoint: fbResolved?.provider.endpoint ?? resolved.provider.endpoint!,
        apiKey: fbResolved?.provider.apiKeyEnv ? getEnv().getApiKey(fbResolved.provider.apiKeyEnv) : apiKey,
        model: fb.model,
        maxContext: fbResolved?.contextWindow ?? resolved.contextWindow,
      });
    }

    if (!ctx.modelHealthRegistry) {
      ctx.modelHealthRegistry = new ModelHealthRegistry(tc?.healthPolicy);
    }
    // Wire auto-demotion
    if (!ctx.modelHealthRegistry.onDemote) {
      ctx.modelHealthRegistry.onDemote = (model, _endpoint, reason) => {
        import("../components/transport-config.js").then(({ demoteModel }) => demoteModel(model, reason));
        import("../components/notification.js").then(({ sendNotification }) =>
          sendNotification(ctx, `⚠️ ${model} demoted (${reason}). Next healthy model promoted.`)).catch(err => logAndSwallow(TAG, "sendNotification model-demote", err));
      };
    }
    const policy = new FallbackPolicy(candidates, ctx.modelHealthRegistry);

    transport = new DirectApiTransport({
      endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey,
      model: resolved.model,
      maxContext: resolved.contextWindow,
      maxOutput: resolved.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
      maxToolRounds: tc?.maxToolRounds ?? 25,
      apiFormat: resolved.provider.apiFormat,
      useProviderLib: resolved.provider.useProviderLib,
      thinking: resolved.provider.thinking,
    }, policy);
    // #1318: debug line showing the L1/L0 route decision at transport-construction time.
    logDebug("boot", `DirectApiTransport: provider=${resolved.providerName} model=${resolved.model} useProviderLib=${resolved.provider.useProviderLib ?? false}`);
    logInfo("main", `🔌 Direct API transport (${resolved.providerName}, model=${resolved.model}, ${candidates.length} candidates)`);
  } else {
    // Kill stale ACP processes from previous run (#921, #1012)
    const { readAndClearAcpPids } = await import("../components/transport/bridge-lock-transport.js");
    const stalePids = readAndClearAcpPids();
    for (const pid of stalePids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
    if (stalePids.length) logDebug("main", `Killed ${stalePids.length} stale ACP process(es)`);
    // #1012: Defense-in-depth — kill kiro-cli acp processes whose CWD is inside ~/.abtars/
    // Safe: agent sessions (AG1-5) have CWD outside ~/.abtars/, won't be touched.
    try {
      const { abtarsHome } = await import("../paths.js");
      const home = abtarsHome();
      const { readlinkSync } = await import("node:fs");
      const candidates = execSync("ps ax -o pid,args 2>/dev/null | grep '[k]iro-cli.*acp' | awk '{print $1}' || true", { encoding: "utf-8", timeout: 3000 }).trim().split("\n").filter(Boolean);
      let killed = 0;
      for (const p of candidates) {
        const pid = parseInt(p, 10);
        if (!pid || pid === process.pid) continue;
        try {
          const cwd = readlinkSync(`/proc/${pid}/cwd`);
          if (cwd.startsWith(home)) { process.kill(pid, "SIGTERM"); killed++; }
        } catch {} // dead, no /proc (macOS), or no permission
      }
      if (killed) logDebug("main", `CWD-checked kill: ${killed} orphan(s)`);
    } catch { /* best effort */ }
    logInfo("main", `🔌 ACP transport (${resolved.provider.cli ?? "kiro-cli"}, model=${resolved.model})`);
    transport = createAgentTransport("professor", {
      cliPath: resolved.provider.cli ?? config.transport.agentCliPath,
      workingDir: config.transport.workingDir,
      agentCli: resolved.provider.cli ?? "kiro-cli",
      model: resolved.model,
    });
  }

  await transport.initialize();

  // SOUL bundle set in phase-pipelineDeps (after memory state resolved) #998

  if (resolved.fallbacks.length > 0 && resolved.provider.transport !== "api") {
    logWarn("main", `⚠️ Fallbacks configured for ${resolved.provider.transport} transport — only API transport supports model fallback`);
  }

  ctx.transport = transport;
  // Flush message queues on reinit — model lost context
  if ("onReinit" in transport) {
    (transport as any).onReinit = () => {
      const { spin } = require("../components/spin.js") as typeof import("../components/spin.js");
      for (const s of spin.listAllSessions()) {
        if (s.queue.length) {
          logWarn("transport", `Reinit: flushing ${s.queue.length} queued message(s)`);
          s.queue.length = 0;
        }
      }
    };
  }
  ctx.modelName = resolved.model;
  ctx.modelProvider = resolved.providerName;
  ctx.fallbackChain = resolved.fallbacks.map((f: { model: string }) => f.model);

  if (ctx.modelHealthRegistry) {
    ctx.runtime.setRegistry(ctx.modelHealthRegistry);
  }
  ctx.runtime.setMainTransport(transport);
  ctx.runtime.setSessionManager(ctx.sessionManager);
  if (ctx.sandboxEnabled) ctx.runtime.setSandboxEnabled(true);

  // Wire async delegation tools (#570)
  if (getEnv().enableAsyncDelegation) {
    const { setDelegationDeps } = await import("../components/transport/delegation-tools.js");
    setDelegationDeps(ctx.runtime);
  }

  logInfo("main", "✓ Transport ready");

  // Wire ActionGate for auth-required commands
  const { join } = await import("node:path");
  const { abtarsHome } = await import("../paths.js");
  const { ActionGate } = await import("../components/action-gate.js");
  const { setActionGate } = await import("../components/transport/tool-registry.js");
  const authDir = join(abtarsHome(), "auth");
  ctx.actionGate = new ActionGate(authDir);
  setActionGate(ctx.actionGate);
  logDebug("main", "🔒 ActionGate wired");

  // #906: Wire seatbelt into tool-registry
  if (ctx.seatbeltActive) {
    const { setSeatbelt } = await import("../components/transport/tool-registry.js");
    const { getPolicy } = await import("../components/seatbelt/index.js");
    const home = abtarsHome();
    const policy = getPolicy("A", join(home, "workspace"), home); // Main session policy
    setSeatbelt(true, policy);
    logDebug("main", "🛡️ Seatbelt wired to tool-registry");
  }

  // #843: Wire memory to DirectApiTransport for session hydration on restart.
  // Transport-specific — only DirectApiTransport has this field.
  if (resolved.provider.transport === "api" && ctx.memory) {
    (transport as import("../components/transport/direct-api-transport.js").DirectApiTransport).memoryBackend = ctx.memory!;

    // Wire context engine for automatic compaction (DirectApiTransport-specific).
    const db = ctx.memory!.getDb?.() ?? ctx.memory!.getDatabase?.();
    if (db && resolved.contextWindow >= 128000) {
      const mod = abmind();
      if (mod) {
        const { ContextEngine } = mod;
        const { createContextOrchestrator } = await import("../components/context/index.js");
        const { spin } = await import("../components/spin.js");
        const { recordCompaction } = await import("../components/metrics-collector.js");
        const contextEngine = new ContextEngine(db);
        // Cheap compaction model: route summarization through Spin as an S-type
        // one-shot (ephemeral, terminateAfter "call") on the dreamy agent. Spin
        // resolves agent → model/provider/metrics; no raw LLM call, no lingering session.
        const compactionModel = (tc ? resolveAgent("dreamy", tc) : null)?.model ?? null;
        const orchestrator = createContextOrchestrator(
          contextEngine,
          (systemPrompt: string, userPrompt: string) =>
            spin.dispatchBackground({ agent: "dreamy", prompt: `${systemPrompt}\n\n${userPrompt}` }),
          (_chatId: string) => {
            try { return ctx.memory?.getLastMessageTimestamp(true) ?? null; } catch (err) { logAndSwallow(TAG, "getLastMessageTimestamp", err); return null; }
          },
          { compactionModel, onCompactionEvent: recordCompaction },
        );
        (transport as import("../components/transport/direct-api-transport.js").DirectApiTransport).contextOrchestrator = orchestrator;
        logInfo("main", `📦 Context engine wired (auto-compaction active, model: ${compactionModel ?? "main"})`);
      }
    }
  }

  if ("onFallback" in transport) {
    let lastNotifiedModel: string | null = null;
    (transport as unknown as { onFallback: (model: string, ctxPct: number, reason?: string) => void }).onFallback = (model, ctxPct, reason) => {
      const reasonTag = reason ? ` (${reason})` : "";
      const msg = `⚡ Fallback${reasonTag}: ${model}${ctxPct >= 0 ? ` (ctx: ~${ctxPct}%)` : ""}`;
      logInfo("main", msg);
      // #1296: notify once per fallback episode. Do NOT bypass on debug — logInfo() above covers
      // debug logging. Re-armed by onPrimaryRestored when primary recovers.
      if (model !== lastNotifiedModel) {
        lastNotifiedModel = model;
        import("../components/notification.js").then(({ sendNotification }) => sendNotification(ctx, msg)).catch(err => logAndSwallow(TAG, "sendNotification fallback", err));
      }
    };
    // #1296: re-arm when primary recovers so the next fallback episode notifies again
    if ("onPrimaryRestored" in transport) {
      (transport as unknown as { onPrimaryRestored: () => void }).onPrimaryRestored = () => {
        lastNotifiedModel = null;
      };
    }
  }
  return "ran";
}

/**
 * Rebuild professor transport in place (picks up transport.json changes).
 * Patches downstream references that captured the old transport (pipelineDeps, idleSave).
 */
export async function rebuildTransport(ctx: BootCtx): Promise<PhaseResult> {
  logInfo("main", "🔄 Rebuilding transport...");
  await buildTransport(ctx);
  if (ctx.pipelineDeps && ctx.transport) {
    (ctx.pipelineDeps as { transport: IKiroTransport }).transport = ctx.transport;
  }
  if (ctx.idleSave && ctx.transport) {
    (ctx.idleSave as unknown as { transport: IKiroTransport }).transport = ctx.transport;
  }
  logInfo("main", "✓ Transport rebuilt");
  return "ran";
}
