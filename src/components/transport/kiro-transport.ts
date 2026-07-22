/**
 * Common interface for communicating with kiro-cli.
 * Both ACP and tmux transports implement this contract.
 */

/**
 * Per-call request metadata threaded from the pipeline through to the
 * transport. #1329: `beforeMessageId` is the exclusive upper bound for
 * DB-backed context assembly; the transport appends the augmented
 * current turn on top of the bounded historical context exactly once.
 *
 * `userId` replaces the previous positional 4th argument so call-site
 * readability and tool-execution delivery are preserved.
 */
export interface PromptRequestContext {
  userId?: string;
  beforeMessageId?: number;
  /** #1445: execution ID for Pi-core host correlation. */
  executionId?: string;
  /**
   * #1338: call-local observer for live TUI output mirroring. Set by Spin per
   * model call/round; transports invoke it alongside existing transport-wide
   * callbacks. Never alters execution, ownership, or results.
   */
  outputObserver?: import("../session-output-feed.js").OutputObserver;
  /** #1335: structured current turn components for Direct API cache-stable assembly. */
  directContextTurn?: {
    rawUserText: string;
    volatileBlocks: ReadonlyArray<{ kind: string; content: string }>;
  };
  /** #1444: execution telemetry scope for provider-call correlation. */
  executionTelemetry?: import("../execution-telemetry.js").ExecutionTelemetryScope;
}

export interface RuntimeUsageSnapshot {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RuntimeStatusSnapshot {
  route?: import("../transport-config.js").ExecutionRoute;
  provider?: string;
  model?: string;
  contextPercent?: number;
  contextWindow?: number;
  autoCompaction?: boolean;
  reasoning?: "off" | "low" | "medium" | "high" | "xhigh" | "default";
  lastTurnUsage?: RuntimeUsageSnapshot;
}

export interface IKiroTransport {
  /** Initialize the transport (spawn process, verify tmux session, etc.) */
  initialize(): Promise<void>;

  /**
   * Send a prompt to Kiro and return the complete response text.
   * For ACP: sends session/prompt and collects streaming chunks.
   * For tmux: sends via send-keys and polls capture-pane for output.
   * For DirectApi: rebuilds context from DB (bounded by
   * `context.beforeMessageId` when set) and appends the current
   * augmented turn on top exactly once (#1329).
   */
  sendPrompt(
    sessionKey: string,
    message: string,
    image?: { mime: string; base64: string },
    context?: PromptRequestContext,
  ): Promise<string>;

  /** Reset/recreate the session for a given chat. */
  resetSession(sessionKey: string): Promise<void>;

  /** Send Ctrl+C interrupt to the running Kiro CLI process. */
  sendInterrupt(reason?: string): Promise<void>;

  /** Clean up resources (kill processes, etc.) */
  destroy(): void;

  /** Whether this transport is currently operational. */
  readonly isReady: boolean;

  /** Callback fired once when transport becomes operational. */
  onReady?: () => void;

  /** Context window usage percentage (0-100). Returns -1 if unknown/unsupported. */
  readonly contextPercent: number;

  /** Clean answer text from last response (stripped of tool output/noise). Empty if not available. */
  readonly answerOnly: string;

  /** Tool calls that succeeded (no error) in the last complete(). 0 if transport doesn't run tools. */
  readonly toolCallsSucceeded: number;

  /** Cumulative text delivered via intermediate streaming (for tail detection). Empty if not available. */
  readonly intermediateDeliveredText: string;

  /** Optional callback for streaming intermediate response chunks. Set by pipeline per-message. */
  onIntermediateResponse?: (text: string) => void;

  /** Optional callback fired at the start of each tool call. Passes tool name. Set by pipeline per-message. */
  onToolCallStart?: (toolName: string) => void;

  /** Optional callback fired when pre-tool text should be delivered before tool execution. */
  onSegmentBreak?: (text: string) => void;

  /** Transport-specific slash commands (e.g. /usage for kiro, /stats for gemini). */
  readonly transportCommands: string[];

  /** Get runtime status snapshot. Implementations return route/provider/model info. */

  /** Execute a transport-specific command. Returns output text. */
  executeCommand?(cmd: string): Promise<string>;

  /** Self-heal check — called by heartbeat. Transport detects and recovers from stuck states. */
  healthCheck?(): Promise<void>;

  /** Restart the CLI session (tmux-only). No-op if not supported. */
  restartSession?(workingDir: string, model?: string): Promise<void>;

  /** Hot-swap provider+model (API transports only). */
  switchProvider?(opts: { provider?: string; endpoint: string; apiKey?: string; model: string; maxContext: number; policy: unknown }): void;

  /** Temporarily override model API timeout for next call(s). null resets to config default. */
  setTimeoutOverride?(ms: number | null): void;

  /** Temporarily override max tool rounds (circuit breaker) for next call(s). null resets to config default. */
  setMaxToolRoundsOverride?(n: number | null): void;

  /** Token usage from the last completed provider call (legacy consumers). */
  lastUsage?(): RuntimeUsageSnapshot | null;

  /** Read-only status projection for operator-facing surfaces such as TUI. */
  getRuntimeStatus?(): RuntimeStatusSnapshot;
}
