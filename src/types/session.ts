/**
 * Per-chat session state mapping a Telegram chat to an ACP session.
 * Note: no ChildProcess reference here — that's managed by AcpClient internally.
 */
export type SessionState = {
  /** Telegram chat identifier */
  telegramChatId: number;
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
