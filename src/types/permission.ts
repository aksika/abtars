/** Tracks a pending permission request awaiting user decision or timeout. */
export type PendingPermission = {
  /** ACP request ID to respond back to kiro-cli */
  acpRequestId: string;
  /** Description of what Kiro wants to do (e.g., "write file auth.ts") */
  action: string;
  /** Telegram chat ID where the inline keyboard was sent */
  telegramChatId: number;
  /** Message ID of the inline keyboard sent to the user */
  telegramMessageId: number;
  /** Auto-deny timer handle */
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Promise resolver — called with the user's decision */
  resolve: (approved: boolean) => void;
};
