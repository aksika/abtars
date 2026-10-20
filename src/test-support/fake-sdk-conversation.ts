/**
 * fake-sdk-conversation.ts — shared Pi SDK conversation double for
 * transport-level tests (test-support: never production, never bundled
 * into behavior).
 *
 * Replaces PiSdkConversationStore (./transport/pi-sdk-conversation.js) and
 * the Agent constructor (via pi-core-types loadAndValidatePiAgentCore).
 * Scripted per-session turns resolve through the same onEvent tap the
 * production store uses, so transport policy (admission, tail mapping,
 * leases, abort) is exercised without a live SDK session. The captured
 * agent options expose the real abtars transformContext for direct
 * admission tests.
 */

export interface FakeSdkTapEvent {
  type: string;
  [key: string]: unknown;
}

export interface FakeSdkTurnScript {
  /** Assistant text delivered via a message_end event. */
  text?: string;
  aborted?: boolean;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextTokens?: number | null;
  toolCallsSucceeded?: number;
  /** Extra events emitted before the terminal message_end. */
  extraEvents?: FakeSdkTapEvent[];
  /** When set, prompt() rejects with this error (pre-run failure). */
  error?: unknown;
  /** When true, prompt() suspends until releaseHold(sessionKey). */
  hold?: boolean;
}

export interface FakeSdkPromptCall {
  sessionKey: string;
  text: string;
  streamFn: unknown;
  tap: ((event: FakeSdkTapEvent) => void) | null;
}

function assistantMessage(text: string): Record<string, unknown> {
  return { role: "assistant", content: text };
}

export class FakeSdkAgent {
  static lastOptions: Record<string, unknown> | null = null;
  static instances: FakeSdkAgent[] = [];
  readonly options: Record<string, unknown>;
  transformContext: ((messages: unknown[], signal?: AbortSignal) => Promise<unknown[]>) | undefined;
  streamFunction: unknown;
  steered: unknown[] = [];
  followedUp: unknown[] = [];
  aborted = false;
  queuesCleared = 0;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeSdkAgent.lastOptions = options;
    FakeSdkAgent.instances.push(this);
    this.transformContext = options["transformContext"] as FakeSdkAgent["transformContext"];
    this.streamFunction = options["streamFn"];
  }

  steer(message: unknown): void {
    this.steered.push(message);
  }

  followUp(message: unknown): void {
    this.followedUp.push(message);
  }

  abort(): void {
    this.aborted = true;
  }

  clearAllQueues(): void {
    this.queuesCleared++;
  }

  static reset(): void {
    FakeSdkAgent.lastOptions = null;
    FakeSdkAgent.instances = [];
  }
}

export function fakeAgentCoreModule(): { Agent: typeof FakeSdkAgent } {
  return { Agent: FakeSdkAgent };
}

export class FakeSdkConversationStore {
  static instances: FakeSdkConversationStore[] = [];
  /** Global script queue per session key (survives lazy store creation). */
  static queuedScripts = new Map<string, FakeSdkTurnScript[]>();
  /** When set, the next ensureConversation call throws (one-shot). */
  static failNextEnsureError: unknown = null;
  ensureCalls: Array<{ key: Record<string, unknown>; assembly: Record<string, unknown> }> = [];
  promptCalls: FakeSdkPromptCall[] = [];
  steerCalls: Array<{ sessionKey: string; message: unknown }> = [];
  followUpCalls: Array<{ sessionKey: string; message: unknown }> = [];
  cancelledKeys: string[] = [];
  evictedKeys: string[] = [];
  waitIdleKeys: string[] = [];
  clearedQueueKeys: string[] = [];
  liveKeys = new Set<string>();
  ensureError: unknown = null;
  private heldResolvers = new Map<string, Array<() => void>>();
  private agents = new Map<string, { transformContext?: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> }>();

  constructor(_args?: Record<string, unknown>) {
    FakeSdkConversationStore.instances.push(this);
  }

  scriptTurn(sessionKey: string, script: FakeSdkTurnScript): void {
    FakeSdkConversationStore.queueTurn(sessionKey, script);
  }

  static queueTurn(sessionKey: string, script: FakeSdkTurnScript): void {
    const queue = FakeSdkConversationStore.queuedScripts.get(sessionKey) ?? [];
    queue.push(script);
    FakeSdkConversationStore.queuedScripts.set(sessionKey, queue);
  }

  async ensureConversation(
    key: Record<string, unknown>,
    assembly: Record<string, unknown>,
  ): Promise<{ conversationId: string; resumed: boolean }> {
    this.ensureCalls.push({ key, assembly });
    if (FakeSdkConversationStore.failNextEnsureError !== null) {
      const err = FakeSdkConversationStore.failNextEnsureError;
      FakeSdkConversationStore.failNextEnsureError = null;
      throw err;
    }
    if (this.ensureError !== null) throw this.ensureError;
    const sessionKey = key["sessionKey"] as string;
    const resumed = this.liveKeys.has(sessionKey);
    this.liveKeys.add(sessionKey);
    const agent = (assembly as { agent?: unknown })["agent"] as
      | { transformContext?: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> }
      | undefined;
    if (agent && typeof agent.transformContext === "function") {
      this.agents.set(sessionKey, { transformContext: agent.transformContext });
    }
    return { conversationId: `conv-${sessionKey}`, resumed };
  }

  hasLive(sessionKey: string): boolean {
    return this.liveKeys.has(sessionKey);
  }

  async prompt(
    sessionKey: string,
    text: string,
    options?: { streamFn?: unknown; images?: unknown; onEvent?: (event: FakeSdkTapEvent) => void },
  ): Promise<{
    text: string;
    aborted: boolean;
    toolCallsSucceeded: number;
    usage: FakeSdkTurnScript["usage"] | null;
    contextTokens: number | null;
  }> {
    const tap = options?.onEvent ?? null;
    this.promptCalls.push({ sessionKey, text, streamFn: options?.streamFn, tap });
    const script = FakeSdkConversationStore.queuedScripts.get(sessionKey)?.shift() ?? {};
    if (script.error !== undefined && script.error !== null) throw script.error;
    // Faithful emulation: the agent transform runs once per turn (safety
    // round limits, admission, system replacement). Production settles a
    // denied request as an error turn instead of propagating, so transform
    // errors are swallowed here — the transport surfaces the denial the
    // real transform recorded on its turn holder.
    try {
      await this.agents.get(sessionKey)?.transformContext?.([], undefined);
    } catch { /* denial recorded on the turn holder; turn settles empty */ }
    if (script.error !== undefined && script.error !== null) throw script.error;
    if (script.hold === true) {
      await new Promise<void>((resolve) => {
        const queue = this.heldResolvers.get(sessionKey) ?? [];
        queue.push(resolve);
        this.heldResolvers.set(sessionKey, queue);
      });
    }
    for (const extra of script.extraEvents ?? []) tap?.(extra);
    if (script.text !== undefined) {
      tap?.({ type: "message_end", message: assistantMessage(script.text) });
    }
    return {
      text: script.text ?? "",
      aborted: script.aborted ?? false,
      toolCallsSucceeded: script.toolCallsSucceeded ?? 0,
      usage: script.usage ?? null,
      contextTokens: script.contextTokens ?? null,
    };
  }

  steer(sessionKey: string, message: unknown): void {
    this.steerCalls.push({ sessionKey, message });
  }

  followUp(sessionKey: string, message: unknown): void {
    this.followUpCalls.push({ sessionKey, message });
  }

  cancel(sessionKey: string): void {
    this.cancelledKeys.push(sessionKey);
  }

  async waitForIdle(sessionKey: string): Promise<void> {
    this.waitIdleKeys.push(sessionKey);
  }

  clearQueue(): void {
    this.clearedQueueKeys.push("store");
  }

  evict(sessionKey: string): void {
    this.evictedKeys.push(sessionKey);
    this.liveKeys.delete(sessionKey);
    this.agents.delete(sessionKey);
  }

  dispose(): void {
    this.liveKeys.clear();
  }

  conversationId(sessionKey: string): string | null {
    return this.liveKeys.has(sessionKey) ? `conv-${sessionKey}` : null;
  }

  /** Release one held prompt for the session key. */
  releaseHold(sessionKey: string): void {
    this.heldResolvers.get(sessionKey)?.shift()?.();
  }

  static resetAll(): void {
    FakeSdkConversationStore.instances = [];
    FakeSdkConversationStore.queuedScripts.clear();
    FakeSdkConversationStore.failNextEnsureError = null;
    FakeSdkAgent.reset();
  }

  static latest(): FakeSdkConversationStore | null {
    return FakeSdkConversationStore.instances.at(-1) ?? null;
  }
}
