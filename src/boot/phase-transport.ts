import { logAndSwallow } from "../components/log-and-swallow.js";
import { getEnv } from "../components/env-schema.js";
/**
 * phase-transport — boot phase 3: select, initialize, and wrap the agent transport.
 *
 * Also exports buildTransport/rebuildTransport for /reset to pick up transport.json changes
 * (including provider switches that can't be live-patched).
 */

import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { TmuxClient } from "../components/transport/tmux-client.js";
import { createAgentTransport } from "../components/agent-registry.js";
import { logInfo, logWarn, logError } from "../components/logger.js";
import { loadUsers } from "../components/user-registry.js";
import { updateCtxStart } from "./ctx-start.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";

export async function phaseTransport(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memoryConfig } = ctx;

  // Pre-flight: tmux session
  if (config.transport.agentTransport === "tmux") {
    logInfo("main", `♻️  Starting tmux session '${config.transport.tmuxSession}'...`);
    try {
      execFileSync(join(import.meta.dirname, "..", "..", "scripts", "tmux-session.sh"), { stdio: "pipe" });
    } catch (err) {
      logError("main", "tmux session start failed", err);
    }
  }

  await buildTransport(ctx);

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
  const { config, memoryConfig } = ctx;

  let transport: IKiroTransport;

  const { resolveAgent, getEnvFallback, loadTransport, resolveHailMary, clearTransportCache, validateProviderReady } = await import("../components/transport-config.js");
  clearTransportCache();  // always re-read (picks up /models change writes)
  const tc = loadTransport();
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

  let resolved = prof ?? (() => {
    const fb = getEnvFallback();
    logWarn("main", `⚠️ Using .env fallback: ${fb.model} via ${fb.providerName}`);
    return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
  })();

  // #367 — validate the resolved provider BEFORE destroying the existing transport.
  // If validation fails and an old transport is up, keep it; surface the error.
  // If no old transport (boot time), try .env fallback.
  const validation = validateProviderReady(resolved.providerName, resolved.provider, getEnv());
  if (!validation.ok) {
    const errMsg = `transport.json configures '${resolved.providerName}' but ${validation.reason}. Fix: ${validation.fix}`;
    if (ctx.transport) {
      // Existing transport still good — keep it. Don't destroy.
      logError("main", `${errMsg} — keeping existing transport up (skipping rebuild)`);
      return "ran";
    }
    // Boot-time: try falling back to .env if we weren't already using it
    if (prof) {
      const fb = getEnvFallback();
      logError("main", `${errMsg} — falling back to .env config (${fb.model} via ${fb.providerName})`);
      resolved = { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
      // Validate fallback too — if even .env is broken, let the original error bubble
      const fbValidation = validateProviderReady(resolved.providerName, resolved.provider, getEnv());
      if (!fbValidation.ok) {
        logError("main", `.env fallback '${resolved.providerName}' also invalid: ${fbValidation.reason}`);
        throw new Error(`${errMsg} (and .env fallback is also invalid: ${fbValidation.reason})`);
      }
    } else {
      // Already on .env fallback path and it's invalid — hard error
      throw new Error(errMsg);
    }
  }

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
    const policy = new FallbackPolicy(candidates, ctx.modelHealthRegistry);

    transport = new DirectApiTransport({
      endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey,
      model: resolved.model,
      maxContext: resolved.contextWindow,
      maxOutput: resolved.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
      apiFormat: resolved.provider.apiFormat,
      thinking: resolved.provider.thinking,
    }, policy);
    logInfo("main", `🔌 Direct API transport (${resolved.providerName}, model=${resolved.model}, ${candidates.length} candidates)`);
  } else {
    try { execSync("pkill -f 'kiro-cli.*acp.*professor' 2>/dev/null || true", { timeout: 3000 }); } catch (err) { logAndSwallow("phase_transport", "op", err); }
    logInfo("main", `🔌 ACP transport (${resolved.provider.cli ?? "kiro-cli"}, model=${resolved.model})`);
    transport = createAgentTransport("professor", {
      cliPath: resolved.provider.cli ?? config.transport.agentCliPath,
      workingDir: config.transport.workingDir,
      agentCli: resolved.provider.cli ?? config.transport.agentCli,
      model: resolved.model,
    });
  }

  await transport.initialize();

  if ("setSystemPrompt" in transport && typeof (transport as { setSystemPrompt: unknown }).setSystemPrompt === "function") {
    const { loadSoulBundle } = await import("../components/soul-loader.js");
    const soul = loadSoulBundle();
    if (soul) (transport as { setSystemPrompt: (p: string) => void }).setSystemPrompt(soul);
  }

  if (resolved.fallbacks.length > 0 && resolved.provider.transport !== "api") {
    logWarn("main", `⚠️ Fallbacks configured for ${resolved.provider.transport} transport — only API transport supports model fallback`);
  }

  ctx.transport = transport;
  ctx.modelName = resolved.model;
  ctx.modelProvider = resolved.providerName;
  ctx.fallbackChain = resolved.fallbacks.map((f: { model: string }) => f.model);

  if (ctx.modelHealthRegistry) {
    ctx.runtime.setRegistry(ctx.modelHealthRegistry);
  }

  logInfo("main", "✅ Transport ready");

  if (resolved.provider.transport === "api" && ctx.memory) {
    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const { SqliteBackend } = await import("abmind");
    const backend = new SqliteBackend(memoryConfig);
    await backend.initialize();
    setMemoryBackend(backend);
    logInfo("main", "🧠 In-process memory wired to tool registry");

    // Wire context engine for automatic compaction
    const db = ctx.memory.getDb?.() ?? ctx.memory.getDatabase?.();
    if (db && resolved.contextWindow >= 128000) {
      const { ContextEngine } = await import("abmind");
      const { createContextOrchestrator } = await import("../components/context/index.js");
      const contextEngine = new ContextEngine(db);
      const orchestrator = createContextOrchestrator(
        contextEngine,
        async (systemPrompt: string, userPrompt: string) => {
          // Use the transport itself for summarization (same model, same endpoint)
          const { streamSingleCompletion } = await import("../components/transport/stream-single.js");
          return streamSingleCompletion({
            endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
            apiKey: getEnv().getApiKey(resolved.provider.apiKeyEnv ?? "API_KEY") ?? undefined,
            model: resolved.model,
            systemPrompt,
            userPrompt,
            maxTokens: 4096,
          });
        },
        (_chatId: string) => {
          try { return ctx.memory?.getLastMessageTimestamp(true) ?? null; } catch { return null; }
        },
      );
      (transport as import("../components/transport/direct-api-transport.js").DirectApiTransport).contextOrchestrator = orchestrator;
      logInfo("main", "📦 Context engine wired (auto-compaction active)");
    }
  }

  if ("onFallback" in transport) {
    (transport as unknown as { onFallback: (model: string, ctxPct: number, reason?: string) => void }).onFallback = (model, ctxPct, reason) => {
      const reasonTag = reason ? ` (${reason})` : "";
      const msg = `⚡ Fallback${reasonTag}: ${model}${ctxPct >= 0 ? ` (ctx: ~${ctxPct}%)` : ""}`;
      logInfo("main", msg);
      import("../components/notification.js").then(({ sendNotification }) => sendNotification(ctx, msg)).catch(() => {});
    };
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
  logInfo("main", "✅ Transport rebuilt");
  return "ran";
}
