/**
 * BootCtx — shared state container for the boot phase sequence.
 *
 * Populated by boot phases in src/boot/phase-*.ts, consumed by later phases
 * and by the Bridge class (for shutdown). Each mutable field is set in
 * exactly one phase.
 */

export type PhaseResult = "ran" | "skipped";

import type { Config } from "../types/index.js";
import type { MemoryConfig, MemoryManager } from "abmind";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";
import type { HeartbeatSystem } from "../components/heartbeat-system.js";
import type { ServiceRegistry } from "../components/service-registry.js";
import type { CronQueue } from "../components/tasks/task-queue.js";
import type { ConversationBuffer } from "../components/conversation-buffer.js";
import type { IdleSave } from "../components/idle-save.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { SubagentRuntime } from "../components/subagent-runtime.js";
import type { CapabilityRegistry } from "../capabilities/capability.js";
import type { IDashboardSlot } from "../components/skeleton.js";
import type { AgentApiServer } from "../components/agent-api-server.js";
import type { PlatformAdapter } from "../types/platform.js";
import { spin as spinInstance } from "../components/spin.js";
import type { ModelHealthRegistry } from "../components/transport/model-health-registry.js";
import type { SttConfig } from "../components/stt.js";
import type { TtsConfig } from "../components/tts.js";
import { SubagentRuntime as SubagentRuntimeClass } from "../components/subagent-runtime.js";
import { ServiceRegistry as ServiceRegistryClass } from "../components/service-registry.js";
import { ConversationBuffer as ConversationBufferClass } from "../components/conversation-buffer.js";
import { createCapabilityRegistry } from "../capabilities/capability.js";

// Lazy forward refs (types only — avoid circular imports)
type TelegramAdapter = import("../platforms/telegram/telegram-adapter.js").TelegramAdapter;
type DiscordAdapter = import("../platforms/discord/discord-adapter.js").DiscordAdapter;
type SleepHandle = import("../capabilities/sleep/index.js").SleepHandle;

/** Flags parsed from CLI args (--telegram, --discord, --web, --agent, --api|--tmux|--acp). */
export interface PlatformFlags {
  telegram: boolean;
  discord: boolean;
  irc: boolean;
  /** #1315: abtars-native TUI socket adapter (unix-domain socket at ~/.abtars/tui.sock). */
  tui: boolean;
  web: boolean;
  agent: boolean;
  transport?: "tmux" | "acp" | "api";
}

export interface BootCtx {
  // ── Static config (set by phase-config, readonly after) ───────────────
  platforms: PlatformFlags;
  config: Config;
  memoryConfig: MemoryConfig;
  startedAt: number;
  bridgeLockPath: string;
  sleepAuditDir: string;
  sttConfig: SttConfig | null;
  ttsConfig: TtsConfig | null;
  nlmConfig: { enabled: boolean; [k: string]: unknown };

  // ── Slots (set by respective phases) ──────────────────────────────────
  runtime: SubagentRuntime;
  memory: MemoryManager | null;
  transport: IKiroTransport | null;
  heartbeat: HeartbeatSystem | null;
  cronQueue: CronQueue | null;
  registry: ServiceRegistry;

  // ── Platform adapters (set by phase-platforms) ────────────────────────
  telegramAdapter: TelegramAdapter | null;
  discordAdapter: DiscordAdapter | null;
  platformAdapters: Map<string, PlatformAdapter>;

  // ── Shared utilities (set by phase-pipeline-deps) ─────────────────────
  conversationBuffer: ConversationBuffer;
  idleSave: IdleSave | null;
  pipelineDeps: PipelineDeps | null;

  // ── Session state ──
  sessionManager: import("../components/spin.js").Spin;

  // ── Subsystems ────────────────────────────────────────────────────────
  capabilities: CapabilityRegistry;
  capabilitiesLoaded: string[];
  sleepHandle: SleepHandle | null;
  modelHealthRegistry: ModelHealthRegistry | null;
  hailMary: { model: string; endpoint: string; apiKey?: string } | null;
  selfHealerTask: { enabled: boolean } | null;
  dashboardServer: IDashboardSlot | null;
  agentApiServer: AgentApiServer | null;
  actionGate: any;
  sandboxEnabled: boolean;
  seatbeltActive: boolean;
  mcpDaemonStarted: boolean;

  // ── Callbacks (closures set by phases for cross-phase use) ────────────
  isSleepActive: () => boolean;
  requestShutdownWithCode: (code: number) => void;
  /** Set by phase-heartbeat; used by phase-sleep to hook the sleep handle. */
  sendSystemMessage?: (prompt: string) => Promise<void>;

  // ── Boot health (populated by dispatcher + phases) ────────────────────
  phaseHealth: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;

  // ── Metadata (populated by phase-config / phase-transport) ────────────
  version: string;
  commit: string;
  modelName: string;
  modelProvider: string;
  fallbackChain: string[];
}

/**
 * Construct a BootCtx with defaults. Test callers pass `overrides` to
 * populate specific fields before invoking a phase in isolation.
 *
 * Production caller (`startBridge`) passes no overrides — phases fill the
 * ctx in order.
 */
export function createBootCtx(overrides: Partial<BootCtx> = {}): BootCtx {
  const defaults: BootCtx = {
    // Static — must be overridden in phase-config before use
    platforms: { telegram: false, discord: false, irc: false, tui: false, web: false, agent: false },
    config: null as unknown as Config,           // set in phase-config
    memoryConfig: null as unknown as MemoryConfig, // set in phase-config
    startedAt: Date.now(),
    bridgeLockPath: "",
    sleepAuditDir: "",
    sttConfig: null,
    ttsConfig: null,
    nlmConfig: { enabled: false },

    // Slots
    runtime: new SubagentRuntimeClass(),
    memory: null,
    transport: null,
    heartbeat: null,
    cronQueue: null,
    registry: new ServiceRegistryClass(),

    // Platforms
    telegramAdapter: null,
    discordAdapter: null,
    platformAdapters: new Map(),

    // Utilities
    conversationBuffer: new ConversationBufferClass(50),
    idleSave: null,
    pipelineDeps: null,

    // Session state
    sessionManager: spinInstance,

    // Subsystems
    capabilities: createCapabilityRegistry(),
    capabilitiesLoaded: [],
    sleepHandle: null,
    modelHealthRegistry: null,
    hailMary: null,
    selfHealerTask: null,
    dashboardServer: null,
    agentApiServer: null,
    actionGate: null,
    sandboxEnabled: false,
    seatbeltActive: false,
    mcpDaemonStarted: false,

    // Callbacks
    isSleepActive: () => false,
    requestShutdownWithCode: () => process.exit(1),

    // Boot health
    phaseHealth: new Map(),

    // Metadata
    version: "?",
    commit: "?",
    modelName: "unknown",
    modelProvider: "unknown",
    fallbackChain: [],
  };
  return { ...defaults, ...overrides };
}
