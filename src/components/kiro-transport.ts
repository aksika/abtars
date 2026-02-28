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
}
