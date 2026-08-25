/**
 * BootCtx — shared state container for the boot phase sequence.
 *
 * Populated by boot phases in src/boot/phase-*.ts, consumed by later phases
 * and by the Bridge class (for shutdown). Each mutable field is set in
 * exactly one phase.
 */

export type PhaseResult = "ran" | "skipped";

import type { Config } from "../types/index.js";
import type { MemoryConfig } from "abmind";
import { createDisabledRuntime } from "../components/memory-runtime.js";
import type { MemoryRecompositionSupervisor } from "../components/memory-recomposition.js";
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
import type { ResolvedHailMary } from "../components/transport-config.js";
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
type SleepUnavailable = import("../capabilities/sleep/index.js").SleepUnavailable;

/** Flags parsed from CLI args (--telegram, --discord, --web, --agent, --api|--tmux|--acp). */
export interface PlatformFlags {
  telegram: boolean;
  discord: boolean;
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
  /** #1380/#1508: memory client (local abmind or abtars signed WSS). */
  client: import("../components/abmind-client-contract.js").AbmindClientLike | null;
  /** #1380: daemon-backed memory runtime facade. Set by phase-memory. */
  memoryRuntime: import("../components/memory-runtime.js").AbtarsMemoryRuntime;
  /**
   * #1706: generation-owned late-composition supervisor. Created idle by
   * phase-memory on recoverable composition failure; startBridge starts it
   * after bootGraph finalization; shutdown cancels and drains it before the
   * memory runtime is closed.
   */
  memoryRecomposition: MemoryRecompositionSupervisor | null;
  /**
   * #1527: late-bound durable context provider. Transport construction and
   * memory negotiation boot in parallel, so phase-pipeline-deps populates
   * this holder once memory is ready; Pi transports read it per call.
   */
  durableContextProvider: import("../components/transport/pi-core-context.js").DurableContextProviderHolder;
  /**
   * #1552: bridge-owned durable memory_store quota service. Created and
   * closed by phase-pipeline-deps / bridge shutdown; read by every Pi
   * transport through the memory-tool dependency holder.
   */
  memoryStoreQuota: import("../components/memory-store-quota.js").MemoryStoreQuota | null;
  /**
   * #1552: late-bound memory-tool dependencies (runtime + quota). Populated
   * by phase-pipeline-deps once memory resolves; cleared before shutdown.
   */
  memoryToolDependencies: import("../components/memory-store-quota.js").MemoryToolDependenciesHolder;
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
  /** #1429 — Boot-owned abmind module reference (set by phase-memory). */
  abmindModule: typeof import("abmind") | null;
  /** #1429 — Boot-recorded sleep-unavailable reason (set by phase-sleep). */
  sleepUnavailable: SleepUnavailable | null;
  sleepHandle: SleepHandle | null;
  modelHealthRegistry: ModelHealthRegistry | null;
  hailMary: (ResolvedHailMary & { apiKey?: string }) | null;
  /**
   * #1468: boot-owned emergency execution service. Constructed at the early
   * platform/recovery composition boundary (phase-platforms-connect) and
   * reused by the full pipeline through PipelineDeps. Independent of Spin,
   * memory readiness, and the normal transport.
   */
  emergencyExecution: import("../components/emergency-execution-service.js").EmergencyExecutionService | null;
  /** #1688: the log-source heartbeat task; no process-local enable toggle. */
  selfHealerTask: import("../types/index.js").HeartbeatTask | null;
  /** #1688: sole SHA admission/transition owner. Set by phase-pipeline-deps. */
  shaCoordinator: import("../components/sha/sha-incident-coordinator.js").ShaIncidentCoordinator | null;
  /**
   * #1724: trusted synthetic-Main-turn boundary for scheduled announcements.
   * Composed once by registerTier3Tasks (inside phase-pipeline-deps) over the
   * pipeline deps and the platform adapter registry; consumed by the Kanban
   * delivery closure. Resolves adapters lazily at delivery time.
   */
  mainIngress: import("../components/main-conversation-ingress.js").MainConversationIngress | null;
  /** #1688: stage-progression nerve subscriber disposer (shutdown). */
  _shaStageSubscriberDisposer?: () => void;
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

  // ── #1319: Orc activity feed ──────────────────────────────────────────
  orcActivityFeed?: import("../components/orc-activity-feed.js").OrcActivityFeed;
  /** Cleanup function returned by bridgeNerveToFeed — called on shutdown. */
  _orcActivityBridgeCleanup?: () => void;

  // ── #1338: Live attached-session output feed ─────────────────────────
  sessionOutputFeed?: import("../components/session-output-feed.js").SessionOutputFeed;

  // ── #1314: Pi coding executor ──────────────────────────────────────────
  piExecutorService?: import("../components/pi-executor/pi-run-service.js").PiRunService;
  /** #1357: Disposer for Pi executor capability registration. Called on shutdown. */
  _piCapDisposer?: () => void;
  /** #1635: interactive Pi coding session service (live-turn interruption on
   * shutdown). */
  codingSessionService?: import("../components/pi-executor/pi-coding-session-service.js").PiCodingSessionService;

  // ── #1554: Reconciler lifecycle ownership ──────────────────────────────
  /** Set by phase-pipeline-deps; owned by the bridge generation, explicitly
   * stopped in Bridge.shutdown before Pi teardown. */
  lifecycleWakeScheduler: import("../components/lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null;
  /** Set by phase-pipeline-deps: scheduled-run projection ports for the
   * Reconciler. Consumed (not mutated) by phase-reconciler. */
  reconcilerInputs: {
    projectRunProgress: (cardId: number) => void;
    failureCascade?: (event: import("../components/sha/sha-types.js").ScheduledFailureEvent) => void;
  } | null;
  /** #1554: set by phase-pipeline-deps; recovery + admission by
   * phase-reconciler after the Reconciler generation starts. */
  scheduledRunCoordinator: import("../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator | null;
  /** Set by phase-reconciler after successful start. */
  reconcilerHandle: import("../components/reconciler.js").ReconcilerHandle | null;
  /** Set by phase-reconciler after successful start. */
  reconcilerRecovery: import("../components/reconciler.js").ReconcilerRecoveryReport | null;
}

/**
 * Detach memory tools before closing their quota ledger.
 *
 * Transports keep the holder by reference, so clearing it first makes any
 * late tool execution fail closed instead of observing a closed quota.
 */
export function clearMemoryToolDependencies(
  ctx: Pick<BootCtx, "memoryToolDependencies" | "memoryStoreQuota">,
): void {
  ctx.memoryToolDependencies.current = null;
  ctx.memoryStoreQuota?.close();
  ctx.memoryStoreQuota = null;
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
    platforms: { telegram: false, discord: false, tui: false, web: false, agent: false },
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
    client: null,
    memoryRuntime: createDisabledRuntime(),
    memoryRecomposition: null,
    durableContextProvider: { current: null },
    memoryStoreQuota: null,
    memoryToolDependencies: { current: null },
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
    abmindModule: null,
    sleepUnavailable: null,
    sleepHandle: null,
    modelHealthRegistry: null,
    hailMary: null,
    emergencyExecution: null,
    selfHealerTask: null,
    shaCoordinator: null,
    mainIngress: null,
    dashboardServer: null,
    agentApiServer: null,
    actionGate: null,
    sandboxEnabled: false,
    seatbeltActive: false,
    mcpDaemonStarted: false,

    // #1554: Reconciler lifecycle slots
    lifecycleWakeScheduler: null,
    reconcilerInputs: null,
    scheduledRunCoordinator: null,
    reconcilerHandle: null,
    reconcilerRecovery: null,

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
