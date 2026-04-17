/**
 * phase-config — boot phase 1: parse CLI flags, load config, set log level.
 *
 * Side effects:
 * - Prepends ~/.agentbridge/bin to PATH
 * - Truncates ~/.agentbridge/logs/launchd.log
 * - Sets log level (module-level singleton: logger.currentLevel)
 * - Emits BRIDGE START + startup log lines
 *
 * Populates ctx: platforms, config, memoryConfig, startedAt, bridgeLockPath,
 * sleepAuditDir, sttConfig, ttsConfig, nlmConfig.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAndValidateConfig } from "../components/config.js";
import { loadMemoryConfig } from "abmind/index.js";
import { parsePlatformFlags } from "../components/cli-flags.js";
import { setLogLevel, logInfo } from "../components/logger.js";
import { loadNLMConfig } from "../components/nlm-command-handler.js";
import { agentBridgeHome } from "../paths.js";
import type { BootCtx } from "./context.js";
import type { SttConfig } from "../components/stt.js";
import type { TtsConfig } from "../components/tts.js";

export async function phaseConfig(ctx: BootCtx): Promise<void> {
  // Ensure ~/.agentbridge/bin is in PATH for child processes (kiro-cli, gemini-cli)
  const binDir = join(agentBridgeHome(), "bin");
  if (!process.env["PATH"]?.includes(binDir)) {
    process.env["PATH"] = `${binDir}:${process.env["PATH"] ?? ""}`;
  }

  ctx.platforms = parsePlatformFlags();
  ctx.config = await loadAndValidateConfig();
  if (ctx.platforms.transport) ctx.config.transport.agentTransport = ctx.platforms.transport;
  setLogLevel(ctx.config.logLevel);

  ctx.memoryConfig = loadMemoryConfig();
  // startedAt set by createBootCtx; preserved here
  ctx.bridgeLockPath = join(agentBridgeHome(), "bridge.lock");
  ctx.sleepAuditDir = join(ctx.memoryConfig.memoryDir, "sleep");

  // STT/TTS/NLM config (lightweight — just reads env vars)
  ctx.sttConfig = ctx.config.voice.sttEnabled
    ? ({ provider: "groq", apiKey: ctx.config.voice.groqApiKey, model: ctx.config.voice.sttModel } satisfies SttConfig)
    : null;
  ctx.ttsConfig = ctx.config.voice.ttsEnabled
    ? ({ voice: ctx.config.voice.ttsVoice } satisfies TtsConfig)
    : null;
  ctx.nlmConfig = loadNLMConfig();

  const enabledList = [
    ctx.platforms.telegram && "telegram",
    ctx.platforms.discord && "discord",
  ].filter(Boolean).join(", ");
  logInfo("main", "──────────── BRIDGE START ────────────");
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${ctx.config.logLevel})`);

  // Truncate launchd.log on startup — bridge logger takes over, previous crash output already captured
  try { writeFileSync(join(agentBridgeHome(), "logs", "launchd.log"), "", "utf-8"); } catch { /* */ }
}
