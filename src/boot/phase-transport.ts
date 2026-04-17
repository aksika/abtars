/**
 * phase-transport — boot phase 3: select, initialize, and wrap the agent transport.
 *
 * Handles:
 * - Pre-flight tmux session start (if transport=tmux)
 * - Agent resolution from transport.json (or .env fallback)
 * - Transport construction: TmuxClient / DirectApiTransport / ACP
 * - System prompt injection for Direct API
 * - TransportManager fallback wrap for non-API transports with fallbacks
 * - ACP stale-process kill before spawn
 * - In-process memory backend wire for Direct API (singleton: setMemoryBackend)
 * - onFallback notification callback (Telegram + logs)
 * - Initialize context-window-start for all known users
 *
 * Populates ctx: transport.
 * Owns singleton: tool-registry.memoryBackend (via setMemoryBackend).
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

  let transport: IKiroTransport;

  // Resolve professor config from transport.json (falls back to .env)
  const { resolveAgent, getEnvFallback, loadTransport } = await import("../components/transport-config.js");
  const tc = loadTransport();
  const prof = tc ? resolveAgent("professor", tc) : null;
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
    const apiKey = resolved.provider.apiKeyEnv ? process.env[resolved.provider.apiKeyEnv] : process.env["API_KEY"];
    const fallbacks = resolved.fallbacks.map(fb => {
      const fbResolved = tc ? resolveAgent("_fallback", { ...tc, agents: { ...tc.agents, _fallback: { model: fb.model, provider: fb.provider } } }) : null;
      return {
        endpoint: fbResolved?.provider.endpoint ?? resolved.provider.endpoint!,
        apiKey: fbResolved?.provider.apiKeyEnv ? process.env[fbResolved.provider.apiKeyEnv] : apiKey,
        model: fb.model,
        maxContext: fbResolved?.contextWindow,
      };
    });
    transport = new DirectApiTransport({
      endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey,
      model: resolved.model,
      maxContext: resolved.contextWindow,
      maxOutput: resolved.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
    });
    logInfo("main", `🔌 Direct API transport (${resolved.providerName}, model=${resolved.model})`);
  } else {
    // ACP
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

  // System prompt for direct API
  if ("setSystemPrompt" in transport && typeof (transport as { setSystemPrompt: unknown }).setSystemPrompt === "function") {
    const { loadSoulBundle } = await import("../components/soul-loader.js");
    const soul = loadSoulBundle();
    if (soul) (transport as { setSystemPrompt: (p: string) => void }).setSystemPrompt(soul);
  }

  // Fallback wrap for non-API transports
  if (resolved.fallbacks.length > 0 && resolved.provider.transport !== "api") {
    const { TransportManager } = await import("../components/transport/transport-manager.js");
    const fb = resolved.fallbacks[0]!;
    transport = new TransportManager(transport, {
      createFallback: async () => {
        const fbAgent = tc ? resolveAgent("_fb", { ...tc, agents: { ...tc.agents, _fb: { model: fb.model, provider: fb.provider } } }) : null;
        if (fbAgent?.provider.transport === "api") {
          const { DirectApiTransport } = await import("../components/transport/direct-api-transport.js");
          return new DirectApiTransport({
            endpoint: fbAgent.provider.endpoint!, apiKey: fbAgent.provider.apiKeyEnv ? process.env[fbAgent.provider.apiKeyEnv] : undefined,
            model: fb.model, maxContext: fbAgent.contextWindow, maxOutput: fbAgent.maxOutput, maxTurns: tc?.maxTurns ?? 50,
          });
        }
        return createAgentTransport("professor", { cliPath: fbAgent?.provider.cli ?? "kiro-cli", workingDir: config.transport.workingDir, model: fb.model });
      },
    });
    logInfo("main", `🛡️ Transport fallback: ${fb.model} via ${fb.provider}`);
  }

  ctx.transport = transport;
  logInfo("main", "✅ Transport ready");

  // In-process memory backend for Direct API (singleton: setMemoryBackend)
  if (resolved.provider.transport === "api" && ctx.memory) {
    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const { SqliteBackend } = await import("abmind/sqlite-backend.js");
    const backend = new SqliteBackend(memoryConfig);
    await backend.initialize();
    setMemoryBackend(backend);
    logInfo("main", "🧠 In-process memory wired to tool registry");
  }

  // Fallback notification callback (fires later; closes over ctx so it reads telegramAdapter when invoked)
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

  // Initialize context-window-start for all known users
  if (memoryConfig.memoryEnabled) {
    const reg = loadUsers();
    for (const user of reg.users) updateCtxStart(memoryConfig.memoryDir, user.userId, ctx.startedAt);
  }
}
