/**
 * phase-config — boot phase 1: parse CLI flags, load config, set log level.
 *
 * Side effects:
 * - Prepends ~/.abtars/bin to PATH
 * - Truncates ~/.abtars/logs/launchd.log
 * - Sets log level (module-level singleton: logger.currentLevel)
 * - Emits BRIDGE START + startup log lines
 *
 * Populates ctx: platforms, config, memoryConfig, startedAt, bridgeLockPath,
 * sleepAuditDir, sttConfig, ttsConfig, nlmConfig.
 */

import { logAndSwallow } from "../components/log-and-swallow.js";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadAndValidateConfig } from "../components/config.js";
import { parsePlatformFlags } from "../components/cli-flags.js";
import { setLogLevel, logInfo } from "../components/logger.js";
import { getEnv } from "../components/env-schema.js";
import { loadNLMConfig } from "../components/nlm-command-handler.js";
import { abtarsHome } from "../paths.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { SttConfig } from "../components/stt.js";
import type { TtsConfig } from "../components/tts.js";

export async function phaseConfig(ctx: BootCtx): Promise<PhaseResult> {
  // Intentional: raw process.env — mutates PATH for child processes (kiro-cli, gemini-cli)
  const binDir = join(abtarsHome(), "bin");
  if (!process.env["PATH"]?.includes(binDir)) {
    process.env["PATH"] = `${binDir}:${process.env["PATH"] ?? ""}`;
  }

  ctx.platforms = parsePlatformFlags();
  ctx.config = await loadAndValidateConfig();
  setLogLevel(ctx.config.logLevel);

  // Resolve memory path from MEMORY env var
  const memoryEnv = getEnv().memory;
  let memoryDir: string;
  let memoryEnabled: boolean;

  if (memoryEnv === "none") {
    memoryEnabled = false;
    memoryDir = "";
  } else if (memoryEnv === "auto") {
    const defaultPath = join(homedir(), ".abmind", "memory");
    memoryEnabled = existsSync(join(defaultPath, "memory.db"));
    memoryDir = defaultPath;
  } else {
    // Explicit path
    memoryDir = memoryEnv.startsWith("~") ? join(homedir(), memoryEnv.slice(1)) : memoryEnv;
    memoryEnabled = true;
  }

  ctx.memoryConfig = { memoryEnabled, memoryDir } as any;
  // startedAt set by createBootCtx; preserved here
  ctx.bridgeLockPath = join(abtarsHome(), "bridge.lock");
  ctx.sleepAuditDir = join(memoryDir || join(homedir(), ".abmind", "memory"), "sleep");

  // Usage tracker
  const { initUsageTracker } = await import("../components/usage-tracker.js");
  initUsageTracker(abtarsHome());

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
  if (ctx.sttConfig) logInfo("main", `🎤 STT enabled (${ctx.sttConfig.provider}/${ctx.sttConfig.model || "whisper-large-v3"})`);
  if (ctx.ttsConfig) logInfo("main", `🔊 TTS enabled (Edge TTS / ${ctx.ttsConfig.voice})`);

  // Truncate launchd.log on startup — bridge logger takes over, previous crash output already captured
  try { writeFileSync(join(abtarsHome(), "logs", "launchd.log"), "", "utf-8"); } catch (err) { logAndSwallow("phase_config", "op", err); }

  // Load hooks config
  const { loadHookConfig } = await import("../components/hooks/hook-system.js");
  loadHookConfig();
  return "ran";
}
