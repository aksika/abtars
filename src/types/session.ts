/**
 * Per-channel session state mapping a platform channel to an ACP session.
 * Uses platform-prefixed keys like "telegram:123" or "discord:456".
 * Note: no ChildProcess reference here — that's managed by AcpClient internally.
 */
export type SessionState = {
  /** Platform-prefixed channel key (e.g. "telegram:123", "discord:456") */
  channelKey: string;
  /** ACP session ID returned by kiro-cli */
  acpSessionId: string;
  /** Whether a prompt is currently being processed */
  isProcessing: boolean;
  /** Current in-flight JSON-RPC request ID, if any */
  pendingRequestId: number | null;
  /** Unix timestamp ms when session was created */
  createdAt: number;
  /** Unix timestamp ms of last message activity */
  lastActivityAt: number;
};
