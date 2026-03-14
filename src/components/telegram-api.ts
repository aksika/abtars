import type {
  TelegramUpdate,
  TelegramInlineKeyboardMarkup,
} from "../types/index.js";

type SendMessageOptions = {
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: TelegramInlineKeyboardMarkup;
  message_thread_id?: number;
};

/**
 * Thin wrapper around the Telegram Bot API using native fetch.
 * All methods throw on HTTP errors.
 */
export class TelegramApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(botToken: string) {
    this.token = botToken;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  /** Get bot info. */
  async getMe(): Promise<{ id: number; username?: string }> {
    const res = await this.call("getMe", {});
    return res as { id: number; username?: string };
  }

  /** Get file path for downloading. */
  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    const res = await this.call("getFile", { file_id: fileId });
    return res as { file_id: string; file_path?: string; file_size?: number };
  }

  /** Download a file by its file_path (from getFile). Returns the raw buffer. */
  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`File download failed (${response.status}): ${filePath}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Send a text message. Returns the sent message_id. */
  async sendMessage(
    chatId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text, ...options };
    const res = await this.call("sendMessage", body);
    return (res as { message_id: number }).message_id;
  }

  /** Acknowledge a callback query (inline keyboard press). */
  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  /** Send a chat action (typing indicator, etc.). */
  async sendChatAction(chatId: number, action: string = "typing", messageThreadId?: number): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action };
    if (messageThreadId) body.message_thread_id = messageThreadId;
    await this.call("sendChatAction", body);
  }

  /** Set an emoji reaction on a message. Pass empty array to remove. */
  async setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: Array<{ type: "emoji"; emoji: string }>,
  ): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction,
    });
  }

  /** Send a voice note (OGG Opus). Returns the sent message_id. */
  async sendVoice(
    chatId: number,
    audioBuffer: Buffer,
    options?: { message_thread_id?: number },
  ): Promise<number> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const blob = new Blob([audioBuffer], { type: "audio/webm" });
    form.append("voice", blob, "voice.webm");
    if (options?.message_thread_id) {
      form.append("message_thread_id", String(options.message_thread_id));
    }

    const response = await fetch(`${this.baseUrl}/sendVoice`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Telegram API sendVoice failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { ok: boolean; result: { message_id: number } };
    if (!json.ok) throw new Error("Telegram API sendVoice returned ok=false");
    return json.result.message_id;
  }

  /** Register bot command menu (shown when user types /). */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  /** Long-poll for updates. */
  async getUpdates(
    offset: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const body = {
      offset,
      timeout,
      allowed_updates: [] as string[], // empty = receive ALL update types
    };
    return (await this.call("getUpdates", body, signal)) as TelegramUpdate[];
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Telegram API ${method} failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { ok: boolean; result: unknown };
    if (!json.ok) {
      throw new Error(`Telegram API ${method} returned ok=false`);
    }
    return json.result;
  }
}
