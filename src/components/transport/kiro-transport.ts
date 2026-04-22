/**
 * Common interface for communicating with kiro-cli.
 * Both ACP and tmux transports implement this contract.
 */
export interface IKiroTransport {
  /** Initialize the transport (spawn process, verify tmux session, etc.) */
  initialize(): Promise<void>;

  /**
   * Send a prompt to Kiro and return the complete response text.
   * For ACP: sends session/prompt and collects streaming chunks.
   * For tmux: sends via send-keys and polls capture-pane for output.
   */
  sendPrompt(sessionKey: string, message: string): Promise<string>;

  /** Reset/recreate the session for a given chat. */
  resetSession(sessionKey: string): Promise<void>;

  /** Send Ctrl+C interrupt to the running Kiro CLI process. */
  sendInterrupt(): Promise<void>;

  /** Clean up resources (kill processes, etc.) */
  destroy(): void;

  /** Whether this transport is currently operational. */
  readonly isReady: boolean;

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

  /** Optional callback fired at the start of each tool call. Set by pipeline per-message. */
  onToolCallStart?: () => void;

  /** Transport-specific slash commands (e.g. /usage for kiro, /stats for gemini). */
  readonly transportCommands: string[];

  /** Execute a transport-specific command. Returns output text. */
  executeCommand?(cmd: string): Promise<string>;

  /** Self-heal check — called by heartbeat. Transport detects and recovers from stuck states. */
  healthCheck?(): Promise<void>;

  /** Restart the CLI session (tmux-only). No-op if not supported. */
  restartSession?(workingDir: string, model?: string): Promise<void>;
}
