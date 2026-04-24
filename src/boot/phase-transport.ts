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
import type { BootCtx } from "./context.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";

export async function phaseTransport(ctx: BootCtx): Promise<void> {
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
}

/**
 * Construct professor transport from current transport.json + env and attach to ctx.transport.
 * Idempotent: destroys any existing ctx.transport first.
 */
export async function buildTransport(ctx: BootCtx): Promise<void> {
  const { config, memoryConfig } = ctx;

  // Destroy old (if any)
  if (ctx.transport) {
    try { await ctx.transport.destroy(); } catch (err) {
      logWarn("main", `Old transport destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.transport = null;
  }

  let transport: IKiroTransport;

  const { resolveAgent, getEnvFallback, loadTransport, resolveHailMary, clearTransportCache } = await import("../components/transport-config.js");
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

  const resolved = prof ?? (() => {
    const fb = getEnvFallback();
    logWarn("main", `⚠️ Using .env fallback: ${fb.model} via ${fb.providerName}`);
    return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
  })();

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
      ctx.modelHealthRegistry = new ModelHealthRegistry();
    }
    const policy = new FallbackPolicy(candidates, ctx.modelHealthRegistry);

    transport = new DirectApiTransport({
      endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey,
      model: resolved.model,
      maxContext: resolved.contextWindow,
      maxOutput: resolved.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
    }, policy);
    logInfo("main", `🔌 Direct API transport (${resolved.providerName}, model=${resolved.model}, ${candidates.length} candidates)`);
  } else {
    try { execSync("pkill -f 'kiro-cli.*acp.*professor' 2>/dev/null || true", { timeout: 3000 }); } catch { /* ok */ }
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

  if (ctx.modelHealthRegistry) {
    ctx.runtime.setRegistry(ctx.modelHealthRegistry);
  }

  logInfo("main", "✅ Transport ready");

  if (resolved.provider.transport === "api" && ctx.memory) {
    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const { SqliteBackend } = await import("abmind/sqlite-backend.js");
    const backend = new SqliteBackend(memoryConfig);
    await backend.initialize();
    setMemoryBackend(backend);
    logInfo("main", "🧠 In-process memory wired to tool registry");
  }

  if ("onFallback" in transport) {
    (transport as unknown as { onFallback: (model: string, ctxPct: number, reason?: string) => void }).onFallback = (model, ctxPct, reason) => {
      const reasonTag = reason ? ` (${reason})` : "";
      const msg = `⚡ Fallback${reasonTag}: ${model}${ctxPct >= 0 ? ` (ctx: ~${ctxPct}%)` : ""}`;
      logInfo("main", msg);
      const chatId = ctx.config.mainChatId;
      if (chatId && ctx.telegramAdapter) {
        ctx.telegramAdapter.sendNotification(String(chatId), msg);
      }
    };
  }
}

/**
 * Rebuild professor transport in place (picks up transport.json changes).
 * Patches downstream references that captured the old transport (pipelineDeps, idleSave).
 */
export async function rebuildTransport(ctx: BootCtx): Promise<void> {
  logInfo("main", "🔄 Rebuilding transport...");
  await buildTransport(ctx);
  if (ctx.pipelineDeps && ctx.transport) {
    (ctx.pipelineDeps as { transport: IKiroTransport }).transport = ctx.transport;
  }
  if (ctx.idleSave && ctx.transport) {
    (ctx.idleSave as unknown as { transport: IKiroTransport }).transport = ctx.transport;
  }
  logInfo("main", "✅ Transport rebuilt");
}
