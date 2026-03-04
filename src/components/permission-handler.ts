import type { PendingPermission } from "../types/index.js";

export type SendInlineKeyboard = (
  chatId: number,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
) => Promise<number>; // returns message_id

/**
 * Handles ACP permission requests. In trust mode, auto-approves.
 * In interactive mode, sends Telegram inline keyboards and waits
 * for user response or timeout.
 */
export class PermissionHandler {
  private readonly trustMode: boolean;
  private readonly timeoutMs: number;
  private readonly sendKeyboard: SendInlineKeyboard;
  private pending = new Map<string, PendingPermission>();

  constructor(trustMode: boolean, timeoutMs: number, sendKeyboard: SendInlineKeyboard) {
    this.trustMode = trustMode;
    this.timeoutMs = timeoutMs;
    this.sendKeyboard = sendKeyboard;
  }

  /**
   * Handle a permission request from ACP.
   * Returns true if approved, false if denied or timed out.
   */
  async handlePermissionRequest(
    acpRequestId: string,
    action: string,
    chatId: number,
  ): Promise<boolean> {
    if (this.trustMode) {
      return true;
    }

    return new Promise<boolean>(async (resolve) => {
      const messageId = await this.sendKeyboard(chatId, `🔐 Kiro wants to: ${action}`, [
        { text: "✅ Approve", callback_data: `perm:approve:${acpRequestId}` },
        { text: "❌ Deny", callback_data: `perm:deny:${acpRequestId}` },
      ]);

      const timeoutHandle = setTimeout(() => {
        this.pending.delete(acpRequestId);
        resolve(false);
      }, this.timeoutMs);

      this.pending.set(acpRequestId, {
        acpRequestId,
        action,
        telegramChatId: chatId,
        telegramMessageId: messageId,
        timeoutHandle,
        resolve,
      });
    });
  }

  /**
   * Handle a callback query from an inline keyboard button press.
   * Returns true if the callback was for a known pending permission.
   */
  handleCallbackQuery(callbackData: string): boolean {
    const match = callbackData.match(/^perm:(approve|deny):(.+)$/);
    if (!match) return false;

    const [, decision, requestId] = match;
    const pending = this.pending.get(requestId!);
    if (!pending) return false;

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(requestId!);
    pending.resolve(decision === "approve");
    return true;
  }

  /** Cancel all pending permissions (e.g., on shutdown). */
  cancelAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve(false);
    }
    this.pending.clear();
  }
}
