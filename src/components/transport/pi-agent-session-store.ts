/**
 * pi-agent-session-store.ts — #1940: Pi-owned in-memory sessions.
 *
 * One live Pi `AgentSession` per logical Spin session, created through Pi's
 * public `createAgentSession` with an in-memory `SessionManager`, an
 * in-memory `SettingsManager`, Pi's `ModelRuntime`, a constrained resource
 * loader, the role system prompt, and exactly the authorized abtars tools.
 *
 * Pi owns the session, history, tool exchanges, queues, provider calls,
 * retries, overflow recovery, context usage, and compaction from here on.
 * abtars sets the session up once and reacts to its events. No bindings,
 * no session files, no recovery, no soul gate, no transform, no memo, no
 * outbox: restart, `/new`, `/reset`, and session end start the next
 * conversation fresh, and continuity comes only from abmind hydration in
 * the first message.
 *
 * Pi packages resolve at runtime through installed-Pi discovery (never a
 * static runtime import — see check-pi-boundary).
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDebug, logWarn } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier } from "../pi-installation.js";
import { getToolDefinitions, executeToolCall, checkToolAvailability } from "./tool-registry.js";
import type { ToolExecutionContext } from "./tool-registry.js";
import { checkTool } from "../tool-sandbox.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import {
  PiCoreToolExecutionError,
  parseToolResultToDiagnostic,
  buildUnknownDiagnostic,
  buildTerminalDiagnostic,
} from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import { limitPiCoreToolResult } from "./pi-core-tools.js";
import { ProviderExecutionError, terminalFailureCodeFor } from "./provider-failure.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { recordDeliveredRecall } from "../answer-evidence.js";
import type { ModelCandidate } from "./model-candidates.js";
import { mapProviderName } from "./pi-catalog.js";
import type { ReasoningEffort } from "./kiro-transport.js";

const TAG = "pi-agent-session-store";

/** Assistant text extraction (mirrors pi-core-transport for message_end). */
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

/** Structural Pi session-factory surface (loaded dynamically). */
export interface PiAgentSessionFactory {
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: PiAgentSessionLike;
  }>;
  SessionManager: {
    inMemory(cwd?: string): unknown;
  };
  SettingsManager: {
    inMemory(): unknown;
  };
  ModelRuntime: {
    create(options?: Record<string, unknown>): Promise<PiModelRuntimeLike>;
  };
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
  };
}

/** Minimal structural AgentSession surface this store consumes. */
export interface PiAgentSessionLike {
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  abort(): Promise<void>;
  clearQueue(): unknown;
  waitForIdle(): Promise<void>;
  dispose(): void;
  steer(text: string, images?: unknown, options?: Record<string, unknown>): void;
  followUp(text: string, images?: unknown, options?: Record<string, unknown>): void;
  setModel(model: unknown, options?: Record<string, unknown>): Promise<void>;
  setThinkingLevel(level: unknown, options?: Record<string, unknown>): void;
  compact(customInstructions?: string): Promise<unknown>;
  getActiveToolNames(): string[];
  /** #1940: restore per-turn exact declarations (sandbox + availability). */
  setActiveToolsByName(toolNames: string[]): void;
  readonly isStreaming: boolean;
}

/** Minimal structural ModelRuntime surface this store consumes. */
export interface PiModelRuntimeLike {
  getModel(providerId: string, modelId: string): unknown;
  registerProvider(providerId: string, config: Record<string, unknown>): void;
}

/** Pure shape check (unit-testable without an installation). */
export function isUsablePiAgentSessionFactory(mod: unknown): mod is PiAgentSessionFactory {
  if (!mod || typeof mod !== "object") return false;
  const record = mod as Record<string, unknown>;
  if (typeof record.createAgentSession !== "function") return false;
  if (typeof record.DefaultResourceLoader !== "function") return false;
  const sessionManager = record.SessionManager as Record<string, unknown> | undefined;
  if (!sessionManager || typeof sessionManager.inMemory !== "function") return false;
  const settingsManager = record.SettingsManager as Record<string, unknown> | undefined;
  if (!settingsManager || typeof settingsManager.inMemory !== "function") return false;
  const modelRuntime = record.ModelRuntime as Record<string, unknown> | undefined;
  if (!modelRuntime || typeof modelRuntime.create !== "function") return false;
  return true;
}

/** Loader for the Pi session factory (injectable for hermetic tests). */
export type PiAgentSessionFactoryLoader = () => Promise<PiAgentSessionFactory | null>;

/**
 * Load the real Pi session factory through installed-Pi discovery. Returns
 * null when Pi is unavailable or the surface is unusable — the caller fails
 * closed, never a silent legacy fallback.
 */
export async function loadPiAgentSessionFactory(): Promise<PiAgentSessionFactory | null> {
  const resolved = resolvePiInstallation();
  if (resolved.state !== "compatible") {
    logWarn(TAG, `Pi unavailable (${resolved.state}) — AgentSessions cannot open`);
    return null;
  }
  try {
    const spec: PiModuleSpecifier = { package: "@earendil-works/pi-coding-agent" };
    const mod = await loadPiModule<Record<string, unknown>>(resolved.installation, spec);
    if (!isUsablePiAgentSessionFactory(mod)) {
      logWarn(TAG, "Pi coding-agent has no usable AgentSession factory surface");
      return null;
    }
    return mod;
  } catch (err) {
    logWarn(TAG, `Pi AgentSession factory load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Per-session tool authority, resolved fresh at each tool call. */
export interface PiAgentSessionToolAuthority {
  /** Current execution holder: set at the start of every turn. */
  current: PiCoreToolContext | null;
  /** Owning Spin session generation: stale holders fail closed. */
  generation: number;
}

/** Session creation inputs (system prompt + model, once per session). */
export interface PiAgentSessionInit {
  systemPrompt: string;
  candidate: ModelCandidate;
  sandboxPolicy: SandboxPolicy;
  sessionType?: import("../spin-types.js").SessionType;
  thinkingLevel?: ReasoningEffort;
  cwd?: string;
  agentDir?: string;
}

export interface PiAgentSessionTurn {
  executionId: string;
  toolContext: PiCoreToolContext;
  images?: Array<{ type: "image"; mimeType?: string; data?: string }>;
  /** Per-turn event mirror for delivery callbacks; cleared at settle. */
  onEvent?: (event: { type: string } & Record<string, unknown>) => void;
}

export interface PiAgentSessionTurnResult {
  text: string;
  aborted: boolean;
  toolCallsSucceeded: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  contextTokens: number | null;
}

interface LivePiAgentSession {
  sessionKey: string;
  session: PiAgentSessionLike;
  sessionManager: unknown;
  settingsManager: unknown;
  authority: PiAgentSessionToolAuthority;
  /** Every registered custom tool name (session-creation sandbox allowlist). */
  allToolNames: string[];
  unsubscribe: () => void;
  settled: { resolve: (result: PiAgentSessionTurnResult) => void; reject: (err: unknown) => void } | null;
  /** Per-turn event mirror for delivery callbacks; cleared at settle. */
  tap: ((event: { type: string } & Record<string, unknown>) => void) | null;
  collector: {
    text: string;
    intermediate: string;
    toolCallsSucceeded: number;
    usage: PiAgentSessionTurnResult["usage"];
    contextTokens: number | null;
    aborted: boolean;
    /** Latest terminal provider error from agent_end (stopReason error). */
    terminalError: string | null;
  } | null;
  safety: PiExecutionSafetyController | null;
  /** Provider requests started in the current prompt run (turn_start count). */
  providerRequests: number;
}

function freshCollector(): NonNullable<LivePiAgentSession["collector"]> {
  return { text: "", intermediate: "", toolCallsSucceeded: 0, usage: null, contextTokens: null, aborted: false, terminalError: null };
}

/**
 * In-memory AgentSession store. Keyed by Spin session id: Main, Orc, and
 * skill sessions keep theirs for the session lifetime; workers and
 * background one-shots release theirs on completion via disposeSession().
 */
export class PiAgentSessionStore {
  private readonly loadFactory: PiAgentSessionFactoryLoader;
  private readonly cwd: string;
  private readonly agentDir: string;
  private factory: PiAgentSessionFactory | null = null;
  private modelRuntime: PiModelRuntimeLike | null = null;
  private readonly live = new Map<string, LivePiAgentSession>();

  constructor(args: {
    loadFactory?: PiAgentSessionFactoryLoader;
    cwd?: string;
    agentDir?: string;
  } = {}) {
    this.loadFactory = args.loadFactory ?? loadPiAgentSessionFactory;
    this.cwd = args.cwd ?? process.cwd();
    // Pi's DefaultResourceLoader requires an explicit agentDir (resolution
    // root for skills/prompts/themes/extension paths); with everything
    // disabled nothing is read from it. abtars-owned, created on demand.
    // In-memory managers mean no session state is ever written there.
    this.agentDir = args.agentDir ?? join(tmpdir(), "abtars-pi-agent");
    try {
      mkdirSync(this.agentDir, { recursive: true });
    } catch { /* best effort; Pi surfaces real failures with context */ }
  }

  /** Marker for the Pi AgentSession route (spin-profiles SOUL-skip duck-type). */
  readonly __piAgentSessionRoute = true;

  private async factoryOrThrow(): Promise<PiAgentSessionFactory> {
    if (!this.factory) {
      const loaded = await this.loadFactory();
      if (!loaded) throw new Error("Pi AgentSession factory unavailable — reinstall Pi");
      this.factory = loaded;
    }
    return this.factory;
  }

  private async runtimeOrThrow(factory: PiAgentSessionFactory): Promise<PiModelRuntimeLike> {
    if (!this.modelRuntime) {
      const runtime = await factory.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
      this.modelRuntime = runtime as PiModelRuntimeLike;
    }
    return this.modelRuntime;
  }

  /**
   * Resolve the Pi model for the configured candidate, registering custom
   * endpoints in memory. Pi's catalog covers known providers; anything it
   * does not know (custom endpoints, fixture/test providers, Pi-managed
   * selections it has not refreshed) is registered in memory with the role
   * model definition — abtars never writes operator model files. A model
   * Pi still does not know after registration fails the session visibly.
   */
  private modelForCandidate(
    runtime: PiModelRuntimeLike,
    candidate: ModelCandidate,
  ): unknown {
    const piProvider = mapProviderName(candidate.provider) ?? candidate.provider;
    // Pi-managed selection of a model Pi already knows: Pi owns the provider
    // definition, endpoint, API shape and auth. Re-registering it with the
    // abtars-guessed API shape would override Pi's own provider.
    if (candidate.authSource === "pi") {
      const native = runtime.getModel(piProvider, candidate.model);
      if (native) return native;
    }
    // Pi API shape: default to completions exactly like the removed
    // candidate-built model path (pickPiApi default).
    const api = candidate.apiFormat === "responses"
      ? "openai-responses"
      : candidate.apiFormat === "anthropic"
        ? "anthropic-messages"
        : "openai-completions";
    const config: Record<string, unknown> = { api };
    if (candidate.endpoint !== undefined) config.baseUrl = candidate.endpoint;
    if (candidate.apiKey !== undefined) config.apiKey = candidate.apiKey;
    if (Object.keys(config).length > 0) {
      try {
        runtime.registerProvider(piProvider, config);
      } catch (err) {
        logWarn(TAG, `registerProvider failed for ${piProvider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const known = runtime.getModel(piProvider, candidate.model) as { id?: string } | undefined;
    if (known) return known;
    // Pi does not know this model: register the role assignment in memory
    // with its endpoint, API shape, and window (mirroring the removed
    // candidate-built model: zero cost, candidate window, resolved max
    // tokens). Auth stays Pi-owned for authSource:'pi' candidates — only
    // the endpoint/model shape is registered, never a credential value.
    if (candidate.endpoint !== undefined) {
      const inlineModel: Record<string, unknown> = {
        id: candidate.model,
        name: candidate.model,
        api,
        baseUrl: candidate.endpoint,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: candidate.thinking?.style === "default"
          || (candidate.thinking?.style === "effort" && candidate.thinking.default !== "off"),
        contextWindow: candidate.maxContext,
        maxTokens: candidate.maxOutput ?? 8192,
      };
      try {
        runtime.registerProvider(piProvider, { ...config, models: [inlineModel] });
      } catch (err) {
        logWarn(TAG, `registerProvider with inline model failed for ${piProvider}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const registered = runtime.getModel(piProvider, candidate.model) as { id?: string } | undefined;
      if (registered) return registered;
    }
    throw new Error(`Model "${candidate.model}" unknown to Pi provider "${candidate.provider}" — pick a model Pi knows`);
  }

  /**
   * Build Pi custom tools from the authorized registry. Every tool's execute
   * resolves the session's CURRENT authority holder — never a first-turn
   * capture — and rechecks generation/cancellation after awaited work.
   */
  private buildCustomTools(
    record: { authority: PiAgentSessionToolAuthority },
    sandboxPolicy: SandboxPolicy,
  ): Array<Record<string, unknown>> {
    const definitions = getToolDefinitions();
    const tools: Array<Record<string, unknown>> = [];
    for (const descriptor of definitions) {
      if (!checkTool(descriptor.name, sandboxPolicy).allowed) continue;
      // Holder-gated availability: evaluated against current authority at
      // registration; per-turn enforcement happens inside execute below.
      tools.push({
        name: descriptor.name,
        label: descriptor.name,
        description: descriptor.description,
        parameters: structuredClone(descriptor.parameters ?? {}) as unknown,
        execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
          const holder = record.authority.current;
          const generationAtCall = record.authority.generation;
          if (!holder) {
            throw new PiCoreToolExecutionError(
              buildUnknownDiagnostic("unknown", descriptor.name, "no live turn authority"),
            );
          }
          const context = holder;
          const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
            ? rawParams as Record<string, unknown>
            : {};
          const toolDecision = context.safety.beforeTool(descriptor.name, params);
          if (toolDecision.decision === "skip") {
            return { content: [{ type: "text", text: "Tool call skipped — batch cancelled" }], details: { skipped: true } };
          }
          if (toolDecision.decision === "error") {
            const decisionDiag = buildUnknownDiagnostic(context.executionId, descriptor.name, toolDecision.reason);
            context.onToolFailure?.(decisionDiag);
            throw new PiCoreToolExecutionError(decisionDiag);
          }
          let outcomeRecorded = false;
          let lastDiag: ToolFailureDiagnosticV1 | undefined;
          try {
            const result = await executeToolCall(descriptor.name, params, {
              userId: context.userId,
              executionId: context.executionId,
              signal: signal ?? context.signal,
              sandboxPolicy: context.sandboxPolicy,
              executionScope: context.executionScope,
              orcContext: context.orcContext,
              workOrigin: context.workOrigin,
              sessionType: context.sessionType,
              memoryToolDeps: context.memoryToolDeps,
              authorizationMode: context.authorizationMode,
              orcTurnControl: context.orcTurnControl,
            } satisfies ToolExecutionContext & { sandboxPolicy?: SandboxPolicy });
            // Generation/cancellation fence: a turn replaced while this
            // tool awaited must not let late results act on the successor.
            if (record.authority.generation !== generationAtCall || signal?.aborted || context.signal?.aborted) {
              return { content: [{ type: "text", text: "Tool call superseded — turn replaced" }], details: { superseded: true } };
            }
            const terminal = context.orcTurnControl?.completed;
            if (terminal?.kind === "intent_satisfied") {
              context.safety.requestStop(`intent satisfied: ${terminal.code}`);
            }
            const diag = parseToolResultToDiagnostic(result, context.executionId, descriptor.name);
            if (diag) lastDiag = diag;
            recordClassifiedStore(descriptor.name, params, result, context.safety);
            const outcome = context.safety.afterTool(descriptor.name, result);
            outcomeRecorded = true;
            if (outcome.decision === "error") {
              const finalDiag = lastDiag
                ? { ...lastDiag, reason: "repeated_failure" as const, safety_incident: "repeated_failure" as const }
                : buildUnknownDiagnostic(context.executionId, descriptor.name, outcome.reason);
              context.onToolFailure?.(finalDiag);
              throw new PiCoreToolExecutionError(finalDiag);
            }
            if (lastDiag) context.onToolFailure?.(lastDiag);
            context.onToolSuccess?.();
            const delivered = limitPiCoreToolResult(descriptor.name, result);
            if (descriptor.name === "memory_recall" && !lastDiag && !signal?.aborted && !context.signal?.aborted) {
              recordDeliveredRecall(context.executionId, delivered);
            }
            return { content: [{ type: "text", text: delivered }], details: { tool: descriptor.name } };
          } catch (err) {
            if (err instanceof PiCoreToolExecutionError) throw err;
            const errorMsg = err instanceof Error ? err.message : String(err);
            const fallbackDiag = buildUnknownDiagnostic(context.executionId, descriptor.name, errorMsg);
            context.onToolFailure?.(fallbackDiag);
            logWarn(TAG, `Tool ${descriptor.name} execution failed [${context.executionId}]`);
            if (!outcomeRecorded) {
              context.safety.afterTool(descriptor.name, JSON.stringify({ error: "unknown" }));
            }
            throw new PiCoreToolExecutionError(fallbackDiag);
          }
        },
      });
    }
    return tools;
  }

  /**
   * Open (or return) the live session. The role system prompt is captured
   * once here and survives Pi compaction; it is never re-injected.
   */
  async ensureSession(sessionKey: string, init: PiAgentSessionInit): Promise<PiAgentSessionLike> {
    const existing = this.live.get(sessionKey);
    if (existing) return existing.session;
    // An empty custom prompt makes Pi fall back to its default coding
    // preamble and tool docs. Every abtars role has a prompt; fail visibly.
    if (init.systemPrompt.trim() === "") {
      throw new Error(`No role system prompt for ${sessionKey} — refusing to open a Pi session with Pi's default prompt`);
    }
    const factory = await this.factoryOrThrow();
    const runtime = await this.runtimeOrThrow(factory);
    const model = this.modelForCandidate(runtime, init.candidate);
    const sessionManager = factory.SessionManager.inMemory(this.cwd);
    const settingsManager = factory.SettingsManager.inMemory();
    const placeholder: LivePiAgentSession = {
      sessionKey,
      session: null as unknown as PiAgentSessionLike,
      sessionManager,
      settingsManager,
      authority: { current: null, generation: 0 },
      allToolNames: [],
      unsubscribe: () => {},
      settled: null,
      tap: null,
      collector: null,
      safety: null,
      providerRequests: 0,
    };
    // Constrained loader: no discovered project context (AGENTS), no
    // SYSTEM files, no skills, no prompt templates, no external extensions.
    // The system prompt is exactly the role SOUL bundle. Pi's built-in
    // file/shell tools stay off via noTools below; the declared tools are
    // exactly the authorized abtars tools.
    const loader = new factory.DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager,
      systemPrompt: init.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // The only extension: abtars' classified-literal scrub (#1446). After a
      // confidential memory_store, its literal is redacted from every later
      // provider request of that execution.
      extensionFactories: [{ name: "abtars-classified-scrub", factory: classifiedScrubExtension(placeholder) }],
    });
    await loader.reload();
    const customTools = this.buildCustomTools(placeholder, init.sandboxPolicy);
    const toolNames = customTools.map((t) => t.name).filter((n): n is string => typeof n === "string");
    const created = await factory.createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      modelRuntime: runtime,
      model,
      ...(init.thinkingLevel !== undefined && init.thinkingLevel !== "off" ? { thinkingLevel: init.thinkingLevel } : {}),
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      customTools,
      // Exactly the authorized tools: nothing else is declared or callable.
      tools: toolNames,
      noTools: "all",
    });
    placeholder.session = created.session;
    placeholder.allToolNames = toolNames;
    placeholder.unsubscribe = created.session.subscribe((event) => this.handleSessionEvent(placeholder, event));
    this.live.set(sessionKey, placeholder);
    logDebug(TAG, `AgentSession opened for ${sessionKey} (${toolNames.length} tools)`);
    return placeholder.session;
  }

  /** True when a live session exists for the key. */
  hasLive(sessionKey: string): boolean {
    return this.live.has(sessionKey);
  }

  /** Live session keys (for fan-out operations like effort changes). */
  sessionKeys(): string[] {
    return [...this.live.keys()];
  }

  /** Send one user turn; resolves on agent_settled (Pi's full settlement). */
  async prompt(sessionKey: string, text: string, turn: PiAgentSessionTurn): Promise<PiAgentSessionTurnResult> {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot prompt — no live AgentSession for ${sessionKey}`);
    if (record.session.isStreaming) {
      throw new Error(`AgentSession for ${sessionKey} already streaming — overlapping prompt rejected`);
    }
    record.authority.current = turn.toolContext;
    record.authority.generation += 1;
    record.safety = turn.toolContext.safety;
    record.providerRequests = 0;
    // #1940: the registered tool set is session-scoped (sandbox allowlist at
    // creation), but authorization is per execution. Activate exactly the
    // tools this turn may present — sandbox plus contextual availability
    // (unattended delivery, Orc intent) — so the model never sees a tool the
    // execution boundary would refuse. Execution still re-checks both.
    const activeToolNames = record.allToolNames.filter((name) =>
      checkTool(name, turn.toolContext.sandboxPolicy).allowed
      && checkToolAvailability(name, turn.toolContext).allowed,
    );
    record.session.setActiveToolsByName(activeToolNames);
    record.collector = freshCollector();
    let resolveDone!: (result: PiAgentSessionTurnResult) => void;
    let rejectDone!: (err: unknown) => void;
    const done = new Promise<PiAgentSessionTurnResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => { /* observed via the prompt throw; prevents unhandled-rejection surfacing */ });
    record.settled = { resolve: resolveDone, reject: rejectDone };
    // Per-turn round bound (#1680): contract authoring keeps its narrow
    // ceiling while execution turns keep the wide bound. Pi owns model
    // rounds; abtars enforces its own prompt-round budget at the turn
    // boundary so a zero/over budget fails closed before any provider call.
    const turnDecision = turn.toolContext.safety.beginProviderTurn(sessionKey);
    if (turnDecision.decision === "stop") {
      const incident = turn.toolContext.safety.lastTerminalIncident;
      const pending = record.settled;
      record.settled = null;
      record.tap = null;
      record.collector = null;
      record.authority.current = null;
      const diag = buildTerminalDiagnostic(
        turn.executionId,
        incident ?? { type: "prompt_round_limit" },
      );
      const err = new PiCoreToolExecutionError(diag);
      pending?.reject(err);
      throw err;
    }
    // Per-turn event mirror for delivery callbacks; cleared at settle.
    record.tap = turn.onEvent ?? null;
    try {
      await record.session.prompt(text, {
        expandPromptTemplates: false,
        ...(turn.images !== undefined ? { images: turn.images } : {}),
      });
    } catch (err) {
      const pending = record.settled;
      record.settled = null;
      record.tap = null;
      record.collector = null;
      record.authority.current = null;
      pending?.reject(err);
      throw err;
    }
    return done;
  }

  /** Steering goes through Pi's steer with abtars lease/generation fencing kept by the caller. */
  steer(sessionKey: string, text: string): void {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot steer — no live AgentSession for ${sessionKey}`);
    record.session.steer(text);
  }

  /** Follow-up goes through Pi's followUp. */
  followUp(sessionKey: string, text: string): void {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot followUp — no live AgentSession for ${sessionKey}`);
    record.session.followUp(text);
  }

  /**
   * Signal-only turn abort: clears Pi's queues and aborts the run without
   * waiting for idleness or disposing the session. The turn settles via
   * agent_settled and reports aborted; a steer/follow-up can still land.
   */
  abortTurn(sessionKey: string): void {
    const record = this.live.get(sessionKey);
    if (!record) return;
    if (record.collector) record.collector.aborted = true;
    try {
      record.session.clearQueue();
    } catch { /* best effort; abort below still runs */ }
    // Pi's abort() also waits for idle; callers that need idleness bound
    // that wait themselves (interrupt), so do not await it here.
    record.session.abort().catch(() => { /* best effort */ });
  }

  /** Await logical idleness after abort. */
  async waitForIdle(sessionKey: string): Promise<void> {
    const record = this.live.get(sessionKey);
    if (!record) return;
    await record.session.waitForIdle();
  }

  /**
   * Lifecycle: clear Pi's queues, abort and wait for idle, then dispose
   * before a successor runs. Nothing late from the old execution affects
   * the successor: the authority generation is retired with the record.
   */
  async disposeSession(sessionKey: string): Promise<void> {
    const record = this.live.get(sessionKey);
    if (!record) return;
    this.live.delete(sessionKey);
    if (record.settled) {
      record.collector && (record.collector.aborted = true);
      record.settled.reject(new Error(`AgentSession disposed for ${sessionKey}`));
      record.settled = null;
    }
    record.authority.current = null;
    try {
      record.session.clearQueue();
    } catch { /* best effort */ }
    try {
      await record.session.abort();
    } catch { /* best effort */ }
    try {
      await record.session.waitForIdle();
    } catch { /* best effort */ }
    try {
      record.unsubscribe();
    } catch { /* best effort */ }
    try {
      record.session.dispose();
    } catch { /* best effort */ }
    logDebug(TAG, `AgentSession disposed for ${sessionKey}`);
  }

  /** Dispose every live session (restart/shutdown). */
  async disposeAll(): Promise<void> {
    const keys = [...this.live.keys()];
    for (const key of keys) {
      await this.disposeSession(key);
    }
  }

  /** Manual compaction through Pi; SOUL survives (system prompt, not history). */
  async compact(sessionKey: string, customInstructions?: string): Promise<unknown> {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot compact — no live AgentSession for ${sessionKey}`);
    return record.session.compact(customInstructions);
  }

  /** Model/thinking changes keep the conversation (no dispose). */
  async setModel(sessionKey: string, model: unknown): Promise<void> {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot setModel — no live AgentSession for ${sessionKey}`);
    await record.session.setModel(model);
  }

  /** Model lookup for /model switches (throws visibly when Pi knows no such model). */
  modelForSwitch(candidate: ModelCandidate): unknown {
    if (!this.modelRuntime) throw new Error("Pi ModelRuntime not ready — send one turn first");
    return this.modelForCandidate(this.modelRuntime, candidate);
  }

  setThinkingLevel(sessionKey: string, level: unknown): void {
    const record = this.live.get(sessionKey);
    if (!record) throw new Error(`Cannot setThinkingLevel — no live AgentSession for ${sessionKey}`);
    record.session.setThinkingLevel(level);
  }

  /**
   * #1680 prompt-round bound per provider request. The first request of a
   * run was admitted in prompt(); every later turn_start is another provider
   * request (tool continuation or steer) and must pass the same bound. A
   * stop aborts the run before that request is streamed.
   */
  private countProviderRequest(record: LivePiAgentSession): void {
    record.providerRequests += 1;
    if (record.providerRequests === 1 || !record.safety) return;
    const decision = record.safety.beginProviderTurn(record.sessionKey);
    if (decision.decision === "continue") return;
    if (decision.decision === "pause") record.safety.requestPause();
    else record.safety.requestStop(decision.reason ?? "Provider turn stopped");
    record.session.abort().catch(() => { /* best effort */ });
  }

  private handleSessionEvent(record: LivePiAgentSession, event: { type: string } & Record<string, unknown>): void {
    if (this.live.get(record.sessionKey) !== record) return;
    if (event.type === "turn_start") this.countProviderRequest(record);
    if (record.tap) {
      try {
        record.tap(event);
      } catch { /* observer isolation */ }
    }
    if (!record.collector) return;
    const collector = record.collector;
    if (event.type === "message_update") {
      const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null | undefined;
      if (streamEv?.type === "text_delta" && streamEv.delta) collector.intermediate += streamEv.delta;
    } else if (event.type === "tool_execution_end") {
      if (event.isError !== true) collector.toolCallsSucceeded++;
    } else if (event.type === "message_end") {
      const message = event.message as { role?: string; content?: unknown; usage?: {
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
            ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
            ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
          };
          const total = usage.totalTokens ?? 0;
          collector.contextTokens = total > 0
            ? total
            : usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        }
      }
    } else if (event.type === "agent_end") {
      // Pi retries internally; agent_end can fire for an intermediate failed
      // attempt. Only the LAST assistant message is this attempt's verdict:
      // record a terminal error when it failed, and CLEAR any earlier retry
      // failure when it succeeded. Scanning the whole message list would
      // surface a stale failure after a successful retry that produced no
      // text (tool-only or empty answer) and fail a completed run.
      const messages = event.messages;
      if (Array.isArray(messages)) {
        let lastAssistant: { stopReason?: string; errorMessage?: string } | null = null;
        for (const message of messages) {
          const m = message as { role?: string; stopReason?: string; errorMessage?: string };
          if (m.role === "assistant") lastAssistant = m;
        }
        collector.terminalError = lastAssistant
          && (lastAssistant.stopReason === "error" || typeof lastAssistant.errorMessage === "string")
          ? (typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.length > 0
            ? lastAssistant.errorMessage
            : "provider error")
          : null;
      }
    } else if (event.type === "agent_settled") {
      const pending = record.settled;
      record.settled = null;
      record.tap = null;
      // #1940 R6: a terminal provider error with no committed text is a
      // visible failure, never a silent empty answer. Real provider errors
      // reach Pi unmodified so its retry and overflow recovery fire first;
      // only Pi's own terminal verdict surfaces here.
      if (collector.text === "" && collector.terminalError !== null && !collector.aborted) {
        const terminal = new ProviderExecutionError({
          code: terminalFailureCodeFor(collector.terminalError),
          retryable: false,
          attemptedCandidates: 1,
          message: `The configured model candidate failed: ${collector.terminalError}`,
        });
        record.collector = null;
        record.authority.current = null;
        pending?.reject(terminal);
        return;
      }
      const result: PiAgentSessionTurnResult = {
        text: collector.text,
        aborted: collector.aborted || event.aborted === true,
        toolCallsSucceeded: collector.toolCallsSucceeded,
        usage: collector.usage,
        contextTokens: collector.contextTokens,
      };
      record.collector = null;
      record.authority.current = null;
      pending?.resolve(result);
    }
    // agent_end is an intermediate terminal before retries: not the run's
    // end. The terminal point is agent_settled (Pi's full settlement).
  }
}

/** Record a confidential memory_store literal for scrubbing (#1446). */
function recordClassifiedStore(
  toolName: string,
  params: Record<string, unknown>,
  result: string,
  safety: PiExecutionSafetyController,
): void {
  if (toolName !== "memory_store") return;
  try {
    const parsed = JSON.parse(result) as { stored?: boolean };
    const classification = Number(params["classification"] ?? params["class"] ?? 1);
    if (parsed.stored === true && classification >= 2 && typeof params["translated"] === "string") {
      safety.recordClassifiedStoreLiteral(params["translated"]);
    }
  } catch {
    // Only valid success envelopes create a scrub literal.
  }
}

/** Inline Pi extension: redact the current execution's classified literals
 *  from each provider request's context (Pi's `context` hook). */
export function classifiedScrubExtension(record: { safety: PiExecutionSafetyController | null }) {
  return (pi: { on(event: "context", handler: (event: { messages: unknown[] }) => { messages: unknown[] } | undefined): void }): void => {
    pi.on("context", (event) => {
      const safety = record.safety;
      if (!safety) return undefined;
      return { messages: safety.scrubClassifiedLiterals(event.messages as never) };
    });
  };
}
