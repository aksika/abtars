import { getEnv } from "../../components/env-schema.js";
import { logDebug } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import type {
  TelegramUpdate,
  TelegramInlineKeyboardMarkup,
} from "../../types/index.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

type SendMessageOptions = {
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: TelegramInlineKeyboardMarkup;
  message_thread_id?: number;
};

const TAG = "telegram-api";

/** Options for fetchWithRetry. */
interface FetchRetryOpts {
  method: string;
  timeoutMs?: number;
  outerSignal?: AbortSignal;
  /** Retry on 4xx responses. Default false — 4xx usually permanent (404 expired, 403 auth). */
  retryable4xx?: boolean;
}

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

  async getChat(chatId: number): Promise<{ id: number; first_name?: string; username?: string }> {
    const res = await this.call("getChat", { chat_id: chatId });
    return res as { id: number; first_name?: string; username?: string };
  }

  /** Get file path for downloading. */
  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    const res = await this.call("getFile", { file_id: fileId });
    return res as { file_id: string; file_path?: string; file_size?: number };
  }

  /** Download a file by its file_path (from getFile). Returns the raw buffer. */
  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    // 4xx = expired file / bad path / wrong token → permanent, don't retry
    const response = await this.fetchWithRetry(
      (signal) => fetch(url, { signal }),
      { method: "downloadFile", timeoutMs: getEnv().telegramFileTimeoutMs, retryable4xx: false },
    );
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

  /** Edit an existing message's text. */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: { parse_mode?: string },
  ): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options });
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
    // Factory rebuilds FormData per attempt — FormData is single-use in some runtimes.
    const makeForm = (): FormData => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      const blob = new Blob([audioBuffer], { type: "audio/webm" });
      form.append("voice", blob, "voice.webm");
      if (options?.message_thread_id) form.append("message_thread_id", String(options.message_thread_id));
      return form;
    };
    const response = await this.fetchWithRetry(
      (signal) => fetch(`${this.baseUrl}/sendVoice`, { method: "POST", body: makeForm(), signal }),
      { method: "sendVoice" },
    );
    const json = (await response.json()) as { ok: boolean; result: { message_id: number } };
    if (!json.ok) throw new Error("Telegram API sendVoice returned ok=false");
    return json.result.message_id;
  }

  /** Send a file from disk as a Telegram document. Returns the sent message_id. */
  async sendDocument(
    chatId: number,
    filePath: string,
    caption?: string,
    options?: { message_thread_id?: number },
  ): Promise<number> {
    const buf = readFileSync(filePath);
    const fileName = basename(filePath);
    // Factory rebuilds FormData per attempt — FormData is single-use in some runtimes.
    const makeForm = (): FormData => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      const blob = new Blob([buf], { type: "text/markdown" });
      form.append("document", blob, fileName);
      if (caption) form.append("caption", caption.slice(0, 1024));
      if (options?.message_thread_id) form.append("message_thread_id", String(options.message_thread_id));
      return form;
    };
    const response = await this.fetchWithRetry(
      (signal) => fetch(`${this.baseUrl}/sendDocument`, { method: "POST", body: makeForm(), signal }),
      { method: "sendDocument", timeoutMs: getEnv().telegramFileTimeoutMs },
    );
    const json = (await response.json()) as { ok: boolean; result: { message_id: number } };
    if (!json.ok) throw new Error("Telegram API sendDocument returned ok=false");
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
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "message_reaction",
      ],
    };
    return (await this.call("getUpdates", body, signal, (timeout + 10) * 1000)) as TelegramUpdate[];
  }

  private static readonly MAX_ATTEMPTS = 3;
  private static readonly BACKOFF = [1000, 3000, 9000];

  private static readonly PERMANENT_ERRORS = [
    /chat not found/i, /bot was blocked/i, /user is deactivated/i,
    /chat_id is empty/i, /forbidden/i, /not enough rights/i,
    /CHAT_WRITE_FORBIDDEN/i, /have no rights/i,
    /wrong file_path/i, /file is temporarily unavailable/i,
  ];

  private static isPermanent(msg: string): boolean {
    return this.PERMANENT_ERRORS.some(re => re.test(msg));
  }

  private static isTransient(msg: string): boolean {
    return /429|5\d\d|bad gateway|service unavailable|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(msg);
  }

  /**
   * Retry + timeout wrapper for any Telegram fetch. Returns the Response on 2xx,
   * throws on non-OK or transient-exhaustion. Factory MUST build a fresh request
   * per attempt (required for FormData; single-use in some runtimes).
   */
  private async fetchWithRetry(
    requestFn: (signal: AbortSignal) => Promise<Response>,
    opts: FetchRetryOpts,
  ): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? getEnv().telegramTimeoutMs;
    for (let attempt = 0; attempt < TelegramApi.MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("telegram timeout")), timeoutMs);
      const composed = opts.outerSignal
        ? AbortSignal.any([opts.outerSignal, ctrl.signal])
        : ctrl.signal;

      try {
        const response = await requestFn(composed);
        if (!response.ok) {
          const text = await response.text().catch(err2 => { logAndSwallow(TAG, "read TG API error body", err2); return ""; });
          const err = new Error(`Telegram API ${opts.method} failed (${response.status}): ${text}`);
          // 4xx treated as permanent unless caller opts in
          if (response.status >= 400 && response.status < 500 && !opts.retryable4xx) throw err;
          throw err;
        }
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (TelegramApi.isPermanent(msg) || opts.outerSignal?.aborted) throw err;
        // Non-retryable 4xx (when retryable4xx is false) — already thrown above with status code
        if (!opts.retryable4xx && /failed \([4]\d\d\)/.test(msg)) throw err;
        if (attempt < TelegramApi.MAX_ATTEMPTS - 1 && TelegramApi.isTransient(msg)) {
          logDebug(TAG, `${opts.method} attempt ${attempt + 1}/${TelegramApi.MAX_ATTEMPTS} — ${msg.slice(0, 80)}`);
          await new Promise(r => setTimeout(r, TelegramApi.BACKOFF[attempt]!));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Telegram API ${opts.method}: unreachable`);
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.fetchWithRetry(
      (composed) => fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: composed,
      }),
      { method, timeoutMs, outerSignal: signal },
    );
    const json = (await response.json()) as { ok: boolean; result: unknown };
    if (!json.ok) throw new Error(`Telegram API ${method} returned ok=false`);
    return json.result;
  }
}
