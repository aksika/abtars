/**
 * pi-sdk-conversation.ts — #1932: Pi-owned in-process conversations.
 *
 * Each live conversation is a real Pi `AgentSession` over a real
 * `SessionManager`, opened in an abtars-owned partition with an
 * abtars-minted conversation ID. The Agent it wraps is built by the caller
 * (transport): abtars keeps its model selection, stream function (memo,
 * telemetry, cache identity), tool authorization inside tool execution, and
 * request-scoped SOUL/hydration transform. Pi owns the transcript, tool
 * exchanges, queues, compaction, and persistence from here on.
 *
 * What this module owns:
 * - durable sessionKey → conversation binding (ID, file, role, workspace);
 * - open-or-create via exact ID (never latest-session discovery);
 * - shared Pi managers (settings/resources isolated under abtars state,
 *   model/auth runtime from the operator installation);
 * - provider registration for the configured candidate (in-memory only);
 * - per-turn prompt/wait-settled collection, abort/drain/idle, eviction.
 *
 * Pi packages resolve at runtime through installed-Pi discovery (never a
 * static runtime import — see check-pi-boundary).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logDebug, logWarn } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import {
  isValidPiConversationId,
  mintPiConversationId,
  resolvePiConversationDir,
  verifyPiConversationFile,
  type PiConversationRole,
  type PiMemoryScope,
} from "../pi-session/pi-conversation-identity.js";

const TAG = "pi-sdk-conversation";

/** Durable binding file beneath the abtars state dir. */
const BINDING_FILENAME = "pi-sdk-conversations-v1.json";
const BINDING_VERSION = 1;
/** Bounded read: the binding file is a small index, never a transcript. */
const MAX_BINDING_BYTES = 256 * 1024;
/** Bounded live conversations per store; overflow evicts the oldest. */
const MAX_LIVE_CONVERSATIONS = 32;

export interface SdkConversationKey {
  /** Transport session key (chat identity). Stable across restarts. */
  sessionKey: string;
  principal: string;
  platform: string;
  role: PiConversationRole;
  workspaceAlias: string;
  canonicalWorkspace: string;
  memoryScope: PiMemoryScope;
  /** Working directory recorded in the Pi session header. */
  cwd?: string;
}

export interface SdkConversationBinding {
  conversationId: string;
  sessionDir: string;
  sessionFile?: string;
  role: PiConversationRole;
  principal: string;
  platform: string;
  workspaceAlias: string;
  updatedAt: number;
}

interface BindingFileShape {
  version: number;
  bindings: Record<string, SdkConversationBinding>;
}

/** Structural Pi SDK surface used here (loaded dynamically). */
export interface PiSdkConversationSurface {
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string }): unknown;
    open(path: string, sessionDir?: string): unknown;
    findById(cwd: string, id: string, sessionDir?: string): string | undefined;
  };
  AgentSession: new (config: Record<string, unknown>) => {
    prompt(text: string, options?: Record<string, unknown>): Promise<void>;
    subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
    abort(): Promise<void>;
    clearQueue(): unknown;
    waitForIdle(): Promise<void>;
    readonly isStreaming: boolean;
    readonly agent: {
      steer(message: unknown): void;
      followUp(message: unknown): void;
      abort(): void;
      clearAllQueues(): void;
      streamFunction: unknown;
    };
  };
  SettingsManager: { create(cwd: string, agentDir?: string): unknown };
  ModelRuntime: {
    create(options?: Record<string, unknown>): Promise<{
      registerProvider(providerId: string, config: Record<string, unknown>): void;
    }>;
  };
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
  };
}

/** Pure shape check (unit-testable without an installation). */
export function isUsableSdkConversationSurface(mod: unknown): mod is PiSdkConversationSurface {
  if (!mod || typeof mod !== "object") return false;
  const surface = mod as unknown as Partial<PiSdkConversationSurface>;
  const SessionManager = surface.SessionManager;
  return Boolean(
    SessionManager &&
    typeof SessionManager.create === "function" &&
    typeof SessionManager.open === "function" &&
    typeof SessionManager.findById === "function" &&
    typeof surface.AgentSession === "function" &&
    surface.SettingsManager && typeof surface.SettingsManager.create === "function" &&
    surface.ModelRuntime && typeof surface.ModelRuntime.create === "function" &&
    typeof surface.DefaultResourceLoader === "function",
  );
}

/**
 * Load the real Pi SDK conversation surface through installed-Pi
 * discovery. Returns null when Pi is unavailable or the surface is
 * unusable — the caller fails closed, never a silent legacy fallback.
 */
export async function loadPiSdkConversationSurface(): Promise<PiSdkConversationSurface | null> {
  const resolved = resolvePiInstallation();
  if (resolved.state !== "compatible") {
    logWarn(TAG, `Pi unavailable (${resolved.state}) — SDK conversations cannot open`);
    return null;
  }
  try {
    const mod = await loadPiModule<Record<string, unknown>>(
      resolved.installation,
      { package: "@earendil-works/pi-coding-agent" },
    );
    if (!isUsableSdkConversationSurface(mod)) {
      logWarn(TAG, "Pi coding-agent has no usable SDK conversation surface");
      return null;
    }
    return mod;
  } catch (err) {
    logWarn(TAG, `Pi SDK conversation surface load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Agent pieces the caller (transport) assembles per conversation. */
export interface SdkAgentAssembly {
  /** Fully built Agent: model, streamFn, tools, abtars transformContext. */
  agent: unknown;
  /** Same tools as AgentTool records for the session loadout. */
  baseTools: Record<string, unknown>;
  toolNames: string[];
  /** Configured provider registration (in-memory only, no files). */
  provider: { providerId: string; baseUrl?: string; apiKey?: string; api?: string };
}

/** Per-turn prompt options. */
export interface SdkPromptOptions {
  images?: Array<{ type: "image"; mimeType?: string; data?: string }>;
  /**
   * Per-turn stream function. The agent persists per conversation but the
   * provider boundary is per turn (execution ID, telemetry, deadlines), so
   * the caller supplies the turn's function and the store installs it before
   * prompting. Agent-core reads streamFunction at each run start.
   */
  streamFn?: unknown;
  onEvent?: (event: { type: string } & Record<string, unknown>) => void;
}

export interface SdkTurnResult {
  text: string;
  aborted: boolean;
  toolCallsSucceeded: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  /** Current-context tokens from the terminal assistant usage, if reported. */
  contextTokens: number | null;
}

export interface SdkConversationEvents {
  onCompaction?: (sessionKey: string) => void;
}

interface LiveSdkConversation {
  sessionKey: string;
  conversationId: string;
  sessionDir: string;
  session: {
    prompt(text: string, options?: Record<string, unknown>): Promise<void>;
    subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
    abort(): Promise<void>;
    clearQueue(): unknown;
    waitForIdle(): Promise<void>;
    readonly isStreaming: boolean;
    readonly agent: {
      steer(message: unknown): void;
      followUp(message: unknown): void;
      abort(): void;
      clearAllQueues(): void;
      streamFunction: unknown;
    };
  };
  sessionManager: { getSessionFile(): string | undefined };
  unsubscribe: () => void;
  settled: { resolve: (result: SdkTurnResult) => void; reject: (err: unknown) => void } | null;
  /** Per-turn event mirror, cleared at settle. */
  tap: ((event: { type: string } & Record<string, unknown>) => void) | null;
  collector: {
    text: string;
    intermediate: string;
    toolCallsSucceeded: number;
    usage: SdkTurnResult["usage"];
    contextTokens: number | null;
    aborted: boolean;
  } | null;
  lastUsed: number;
}

function freshCollector(): NonNullable<LiveSdkConversation["collector"]> {
  return { text: "", intermediate: "", toolCallsSucceeded: 0, usage: null, contextTokens: null, aborted: false };
}

export class PiSdkConversationStore {
  private readonly stateDir: string;
  private readonly sessionStorageRoot: string;
  private readonly loadSurface: () => Promise<PiSdkConversationSurface | null>;
  private readonly events: SdkConversationEvents;
  private surface: PiSdkConversationSurface | null = null;
  private managers: {
    settingsManager: unknown;
    modelRuntime: { registerProvider(providerId: string, config: Record<string, unknown>): void };
    resourceLoader: { reload(): Promise<void> };
  } | null = null;
  private readonly live = new Map<string, LiveSdkConversation>();

  constructor(args: {
    stateDir: string;
    sessionStorageRoot: string;
    loadSurface?: () => Promise<PiSdkConversationSurface | null>;
    events?: SdkConversationEvents;
  }) {
    this.stateDir = args.stateDir;
    this.sessionStorageRoot = args.sessionStorageRoot;
    this.loadSurface = args.loadSurface ?? loadPiSdkConversationSurface;
    this.events = args.events ?? {};
  }

  /** Open (or create) the live SDK conversation for a session key. */
  async ensureConversation(key: SdkConversationKey, assembly: SdkAgentAssembly): Promise<{ conversationId: string; resumed: boolean }> {
    const existing = this.live.get(key.sessionKey);
    if (existing) {
      existing.lastUsed = Date.now();
      return { conversationId: existing.conversationId, resumed: true };
    }
    const surface = await this.loadedSurface();
    if (!surface) throw new Error("Pi SDK conversation surface unavailable");
    const managers = await this.loadedManagers(surface);
    managers.modelRuntime.registerProvider(assembly.provider.providerId, {
      ...(assembly.provider.baseUrl !== undefined ? { baseUrl: assembly.provider.baseUrl } : {}),
      ...(assembly.provider.apiKey !== undefined ? { apiKey: assembly.provider.apiKey } : {}),
      ...(assembly.provider.api !== undefined ? { api: assembly.provider.api } : {}),
    });

    const cwd = key.cwd ?? process.cwd();
    const bindings = this.loadBindings();
    const bound = bindings[key.sessionKey];
    let conversationId: string;
    let sessionDir: string;
    let sessionManager: {
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
    let resumed = false;

    if (bound && isValidPiConversationId(bound.conversationId)) {
      conversationId = bound.conversationId;
      sessionDir = bound.sessionDir;
      const found = surface.SessionManager.findById(cwd, conversationId, sessionDir);
      if (!found) {
        throw new Error(`SDK conversation file missing for ${conversationId} (no silent fallback)`);
      }
      const proof = verifyPiConversationFile(
        this.sessionStorageRoot,
        sessionDir,
        conversationId,
        found,
        (file) => this.readFileHeaderId(file),
      );
      if (!proof.ok) {
        throw new Error(`SDK conversation file unverified for ${conversationId}: ${proof.reason}`);
      }
      sessionManager = surface.SessionManager.open(proof.canonicalFile, sessionDir) as typeof sessionManager;
      if (sessionManager.getSessionId() !== conversationId) {
        throw new Error(`SDK conversation header mismatch for ${conversationId}`);
      }
      resumed = true;
    } else {
      conversationId = mintPiConversationId();
      sessionDir = resolvePiConversationDir(this.sessionStorageRoot, key.principal, key.role, key.canonicalWorkspace);
      sessionManager = surface.SessionManager.create(cwd, sessionDir, { id: conversationId }) as typeof sessionManager;
      this.saveBinding(key, {
        conversationId,
        sessionDir,
        sessionFile: sessionManager.getSessionFile(),
        role: key.role,
        principal: key.principal,
        platform: key.platform,
        workspaceAlias: key.workspaceAlias,
        updatedAt: Date.now(),
      });
    }

    const session = new surface.AgentSession({
      agent: assembly.agent,
      sessionManager,
      settingsManager: managers.settingsManager,
      cwd,
      resourceLoader: managers.resourceLoader,
      modelRuntime: managers.modelRuntime,
      baseToolsOverride: assembly.baseTools,
      initialActiveToolNames: assembly.toolNames,
      allowedToolNames: assembly.toolNames,
    });
    const record: LiveSdkConversation = {
      sessionKey: key.sessionKey,
      conversationId,
      sessionDir,
      session,
      sessionManager,
      unsubscribe: () => {},
      settled: null,
      tap: null,
      collector: null,
      lastUsed: Date.now(),
    };
    record.unsubscribe = session.subscribe((event) => this.handleSessionEvent(key.sessionKey, event));
    this.live.set(key.sessionKey, record);
    this.evictOverflow();
    // Lazily record the session file once Pi flushes it (first message).
    this.refreshBindingFile(key.sessionKey, sessionManager);
    logDebug(TAG, `SDK conversation ${resumed ? "reopened" : "created"} ${conversationId} for ${key.sessionKey}`);
    return { conversationId, resumed };
  }

  /** Send one user turn through the live SDK session; resolves on agent_settled. */
  async prompt(key: SdkConversationKey, text: string, assembly: SdkAgentAssembly, options?: SdkPromptOptions): Promise<SdkTurnResult> {
    await this.ensureConversation(key, assembly);
    const record = this.live.get(key.sessionKey);
    if (!record) throw new Error(`SDK conversation missing after ensure for ${key.sessionKey}`);
    if (record.session.isStreaming) {
      throw new Error(`SDK conversation ${record.conversationId} already streaming — overlapping prompt rejected`);
    }
    record.collector = freshCollector();
    const done = new Promise<SdkTurnResult>((resolve, reject) => {
      record.settled = { resolve, reject };
    });
    if (options?.streamFn !== undefined) {
      record.session.agent.streamFunction = options.streamFn;
    }
    // Per-turn event tap (mirrors every session event to the caller).
    record.tap = options?.onEvent ?? null;
    try {
      await record.session.prompt(text, {
        expandPromptTemplates: false,
        ...(options?.images !== undefined ? { images: options.images } : {}),
      });
    } catch (err) {
      record.settled = null;
      record.collector = null;
      throw err;
    }
    const result = await done;
    this.refreshBindingFile(key.sessionKey, record.sessionManager);
    return result;
  }

  /** Direct agent steer (instruction-queue leases; role never persisted by Pi). */
  steer(sessionKey: string, message: unknown): void {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot steer — no live SDK conversation for ${sessionKey}`);
    record.session.agent.steer(message);
  }

  /** Direct agent follow-up (instruction-queue leases). */
  followUp(sessionKey: string, message: unknown): void {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot followUp — no live SDK conversation for ${sessionKey}`);
    record.session.agent.followUp(message);
  }

  /**
   * Signal cancellation: abort the run and clear both Pi queues. Signal-only
   * and never awaits idleness: the provider attempt bounds its own acquisition
   * (inactivity timeout), and awaiting idle here would deadlock sendInterrupt
   * while acquisition is still gated. The turn promise settles via
   * agent_settled and reports aborted.
   */
  cancel(sessionKey: string): void {
    const record = this.live.get(sessionKey);
    if (!record) return;
    if (record.collector) record.collector.aborted = true;
    try {
      record.session.clearQueue();
    } catch { /* best effort; abort below still runs */ }
    try {
      record.session.agent.clearAllQueues();
    } catch { /* best effort */ }
    record.session.agent.abort();
  }

  /** Await logical idleness after abort. */
  async waitForIdle(sessionKey: string): Promise<void> {
    const record = this.live.get(sessionKey);
    if (!record) return;
    await record.session.waitForIdle();
  }

  /** Evict one conversation (unsubscribe; Pi state stays on disk). */
  evict(sessionKey: string): void {
    const record = this.live.get(sessionKey);
    if (!record) return;
    try {
      record.unsubscribe();
    } catch { /* best effort */ }
    if (record.settled) {
      record.settled.reject(new Error(`SDK conversation evicted for ${sessionKey}`));
      record.settled = null;
    }
    record.collector = null;
    this.live.delete(sessionKey);
  }

  /** Evict everything (process teardown). */
  dispose(): void {
    for (const key of [...this.live.keys()]) this.evict(key);
  }

  get liveCount(): number {
    return this.live.size;
  }

  conversationId(sessionKey: string): string | null {
    return this.live.get(sessionKey)?.conversationId ?? this.loadBindings()[sessionKey]?.conversationId ?? null;
  }

  private handleSessionEvent(
    sessionKey: string,
    event: { type: string } & Record<string, unknown>,
  ): void {
    const record = this.live.get(sessionKey);
    if (record?.tap) {
      try {
        record.tap(event);
      } catch { /* observer isolation */ }
    }
    if (event.type === "compaction_end") {
      try {
        this.events.onCompaction?.(sessionKey);
      } catch { /* observer isolation */ }
    }
    if (!record?.collector) return;
    const collector = record.collector;
    if (event.type === "message_update") {
      const streamEv = event["assistantMessageEvent"] as { type?: string; delta?: string } | null;
      if (streamEv?.type === "text_delta" && streamEv.delta) collector.intermediate += streamEv.delta;
    } else if (event.type === "tool_execution_end") {
      if (event["isError"] !== true) collector.toolCallsSucceeded++;
    } else if (event.type === "message_end") {
      const message = event["message"] as { role?: string; content?: unknown; usage?: {
        input: number; output: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number;
      } } | undefined;
      if (message?.role === "assistant") {
        const text = extractAssistantText(message.content);
        if (text) collector.text = text;
        const usage = message.usage;
        if (usage && (usage.input > 0 || usage.output > 0)) {
          collector.usage = {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          };
          const total = usage.totalTokens ?? 0;
          collector.contextTokens = total > 0
            ? total
            : usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        }
      }
    } else if (event.type === "agent_settled") {
      const settled = record.settled;
      record.settled = null;
      record.tap = null;
      if (settled) {
        settled.resolve({
          text: collector.text,
          aborted: collector.aborted,
          toolCallsSucceeded: collector.toolCallsSucceeded,
          usage: collector.usage,
          contextTokens: collector.contextTokens,
        });
      }
      record.collector = null;
    }
  }

  private async loadedSurface(): Promise<PiSdkConversationSurface | null> {
    if (!this.surface) this.surface = await this.loadSurface();
    return this.surface;
  }

  private async loadedManagers(surface: PiSdkConversationSurface): Promise<{
    settingsManager: unknown;
    modelRuntime: { registerProvider(providerId: string, config: Record<string, unknown>): void };
    resourceLoader: { reload(): Promise<void> };
  }> {
    if (!this.managers) {
      // Settings/resources are isolated under abtars state so operator Pi
      // extensions, skills, and prompt packs never enter bridge turns.
      // Auth/models resolve from the operator installation (OAuth logins
      // and catalog stay Pi-owned).
      const agentDir = join(this.stateDir, "pi-sdk-agent");
      mkdirSync(agentDir, { recursive: true });
      const settingsManager = surface.SettingsManager.create(process.cwd(), agentDir);
      const modelRuntime = await surface.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
      const resourceLoader = new surface.DefaultResourceLoader({ cwd: process.cwd(), agentDir, settingsManager });
      await resourceLoader.reload();
      this.managers = { settingsManager, modelRuntime, resourceLoader };
    }
    return this.managers;
  }

  private bindingPath(): string {
    return join(this.stateDir, BINDING_FILENAME);
  }

  private loadBindings(): Record<string, SdkConversationBinding> {
    let raw: string;
    try {
      raw = readFileSync(this.bindingPath(), "utf-8");
    } catch {
      return {};
    }
    if (raw.length > MAX_BINDING_BYTES) {
      logWarn(TAG, "SDK conversation bindings exceed size bound; using empty index");
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BindingFileShape>;
      if (parsed.version !== BINDING_VERSION || typeof parsed.bindings !== "object" || parsed.bindings === null) return {};
      return parsed.bindings;
    } catch {
      logWarn(TAG, "SDK conversation bindings unreadable; using empty index");
      return {};
    }
  }

  private saveBinding(key: SdkConversationKey, binding: SdkConversationBinding): void {
    const bindings = this.loadBindings();
    bindings[key.sessionKey] = binding;
    this.writeBindings(bindings);
  }

  private writeBindings(bindings: Record<string, SdkConversationBinding>): void {
    mkdirSync(this.stateDir, { recursive: true });
    const path = this.bindingPath();
    const tmp = `${path}.${randomUUID()}.tmp`;
    const shape: BindingFileShape = { version: BINDING_VERSION, bindings };
    writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
    renameSync(tmp, path);
  }

  private refreshBindingFile(
    sessionKey: string,
    sessionManager: { getSessionFile(): string | undefined },
  ): void {
    let file: string | undefined;
    try {
      file = sessionManager.getSessionFile();
    } catch {
      return;
    }
    if (!file) return;
    const bindings = this.loadBindings();
    const bound = bindings[sessionKey];
    if (!bound || bound.sessionFile === file) return;
    bound.sessionFile = file;
    bound.updatedAt = Date.now();
    try {
      this.writeBindings(bindings);
    } catch {
      // best effort; the ID binding is already durable
    }
  }

  private readFileHeaderId(file: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    const firstLine = raw.split("\n", 1)[0] ?? "";
    try {
      const header = JSON.parse(firstLine) as { id?: unknown };
      return typeof header.id === "string" ? header.id : null;
    } catch {
      return null;
    }
  }

  private evictOverflow(): void {
    while (this.live.size > MAX_LIVE_CONVERSATIONS) {
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.live) {
        if (record.lastUsed < oldestAt) {
          oldestAt = record.lastUsed;
          oldest = key;
        }
      }
      if (oldest === null) return;
      logDebug(TAG, `evicting oldest live SDK conversation for ${oldest} (bound)`);
      this.evict(oldest);
    }
  }
}

/** Assistant text extraction (mirrors the transport helper without the dependency). */
function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object"
      && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("");
}

/** Scratch-dir helper for tests (real SDK surface, isolated managers). */
export function testScratchDirs(): { stateDir: string; sessionRoot: string } {
  const base = join(tmpdir(), `pi-sdk-conv-${randomUUID()}`);
  mkdirSync(join(base, "state"), { recursive: true });
  mkdirSync(join(base, "sessions"), { recursive: true });
  return { stateDir: join(base, "state"), sessionRoot: join(base, "sessions") };
}
