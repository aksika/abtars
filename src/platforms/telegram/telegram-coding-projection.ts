/**
 * telegram-coding-projection.ts — #1635 bounded Telegram projection for
 * interactive Pi coding sessions.
 *
 * Bounded presentation, separate from the executor's content-free delegated
 * projection (never weakened to reuse it):
 *   - assistant text chunked to platform limits;
 *   - one editable progress message per turn;
 *   - tool names and lifecycle only — no arguments, no output;
 *   - confirm/select as inline controls, input/editor as correlated prompts;
 *   - final usage and changed-file summary;
 *   - busy/retry/non-resumable states as bounded replies.
 *
 * The adapter is registered lazily at platform boot (the Pi boot phase runs
 * before platform connect).
 */

import type { PlatformAdapter, SendOpts } from "../../types/platform.js";
import type { PiCodingProjectionSink } from "../../components/pi-executor/pi-coding-session-service.js";
import type { PiCodingSessionStore } from "../../components/pi-executor/pi-coding-session-store.js";
import type { TelegramApi } from "./telegram-api.js";
import { logWarn } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { randomUUID } from "node:crypto";

const TAG = "telegram-coding";
const MAX_UI_OPTIONS = 10;
const MAX_CALLBACK_TOKENS = 256;

type CodingCallbackHandler = (sessionId: string, requestId: string, value: string, chatId: number) => Promise<boolean>;
interface CodingCallback {
  sessionId: string;
  requestId: string;
  value: string;
}

let adapter: PlatformAdapter | null = null;
let api: TelegramApi | null = null;
let callbackHandler: CodingCallbackHandler | null = null;
const callbackTokens = new Map<string, CodingCallback>();

/** #1635 — wire the Telegram adapter for coding projection (platform boot). */
export function setTelegramCodingDelivery(a: PlatformAdapter | null, tgApi: TelegramApi | null): void {
  adapter = a;
  api = tgApi;
}

/** #1635 — wire the service reply path for inline control callbacks. */
export function setCodingCallbackHandler(cb: CodingCallbackHandler | null): void {
  callbackHandler = cb;
  if (!cb) callbackTokens.clear();
}

export function isCodingCallback(data: string): boolean {
  return data.startsWith("coding:");
}

function callbackData(sessionId: string, requestId: string, value: string): string {
  const token = randomUUID().replaceAll("-", "");
  callbackTokens.set(token, { sessionId, requestId, value });
  while (callbackTokens.size > MAX_CALLBACK_TOKENS) {
    const oldest = callbackTokens.keys().next().value as string | undefined;
    if (!oldest) break;
    callbackTokens.delete(oldest);
  }
  // Telegram limits callback_data to 64 bytes. Keep session/request/value
  // out of the transport payload; the bounded in-process map also prevents a
  // caller from forging a reply by guessing durable identifiers.
  return `coding:${token}`;
}

function clearRequestTokens(sessionId: string, requestId: string): void {
  for (const [token, pending] of callbackTokens) {
    if (pending.sessionId === sessionId && pending.requestId === requestId) callbackTokens.delete(token);
  }
}

/** `coding:<opaque-token>` callback routing. */
export async function handleCodingCallback(data: string, chatId: number): Promise<boolean> {
  if (!callbackHandler) return false;
  const token = data.slice("coding:".length);
  const pending = callbackTokens.get(token);
  if (!pending) {
    if (api) await api.sendMessage(chatId, "Pi control expired — the request is no longer pending.").catch(err => logAndSwallow(TAG, `send expired-control notice to ${chatId}`, err));
    return true;
  }
  callbackTokens.delete(token);
  const ok = await callbackHandler(pending.sessionId, pending.requestId, pending.value, chatId);
  if (ok) clearRequestTokens(pending.sessionId, pending.requestId);
  if (!ok && api) {
    await api.sendMessage(chatId, "Pi control expired — the request is no longer pending.").catch(err => logAndSwallow(TAG, `send expired-control notice to ${chatId}`, err));
  }
  return true;
}

function send(chatId: string, text: string, opts?: SendOpts): Promise<number | string | undefined> {
  if (!adapter) return Promise.resolve(undefined);
  const clean = text.slice(0, 3500);
  return adapter.sendMessage(chatId, clean, opts).catch((err) => {
    logWarn(TAG, `Projection send failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
}

function editOrSend(chatId: string, existing: number | string | undefined, text: string): Promise<number | string | undefined> {
  if (existing !== undefined && adapter?.editMessage) {
    return adapter.editMessage(chatId, existing, text)
      .then(() => existing)
      .catch(() => send(chatId, text));
  }
  return send(chatId, text);
}

/** #1635 — create the projection sink bound to the coding session store.
 * The chat delivery target is the row's `chatId` (operational metadata). */
export function createCodingProjectionSink(store: PiCodingSessionStore): PiCodingProjectionSink {
  const progressMsg = new Map<string, number | string>();

  const chatFor = (sessionId: string): string | null => store.get(sessionId)?.chatId ?? null;

  const progress = (sessionId: string, text: string): void => {
    const chat = chatFor(sessionId);
    if (!chat) return;
    const existing = progressMsg.get(sessionId);
    if (existing !== undefined) {
      editOrSend(chat, existing, text).then((id) => {
        if (id !== undefined) progressMsg.set(sessionId, id);
      });
    } else {
      send(chat, text).then((id) => {
        if (id !== undefined) progressMsg.set(sessionId, id);
      });
    }
  };

  const sink: PiCodingProjectionSink = {
    progress,

    tool(sessionId, name, started) {
      // tool names and lifecycle only — no arguments, no output
      progress(sessionId, `${started ? "+" : "-"} ${name}`);
    },

    uiRequest(sessionId, request) {
      const chat = chatFor(sessionId);
      if (!chat) return;
      const title = String((request as { title?: unknown }).title ?? "Pi requests input");
      if (request.method === "confirm") {
        void send(chat, title, {
          reply_markup: {
            inline_keyboard: [[
              { text: "Yes", callback_data: callbackData(sessionId, request.id, "true") },
              { text: "No", callback_data: callbackData(sessionId, request.id, "false") },
            ]],
          },
        });
        return;
      }
      if (request.method === "select") {
        const options = ((request as { options?: unknown }).options as string[] | undefined) ?? [];
        const rows = options.slice(0, MAX_UI_OPTIONS).map((opt) => ([
          { text: opt.slice(0, 60), callback_data: callbackData(sessionId, request.id, opt) },
        ]));
        void send(chat, `${title}\n\nSelect an option:`, {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }
      // input / editor — correlated prompt in chat
      const placeholder = String((request as { placeholder?: unknown }).placeholder ?? (request as { prefill?: unknown }).prefill ?? "");
      const extra = placeholder ? `\n\nSuggested: ${placeholder.slice(0, 200)}` : "";
      void send(chat, `* Pi asks (${request.method}): ${title}${extra}\n\nReply with your answer — it is submitted to Pi.`);
    },

    assistantText(sessionId, text) {
      const chat = chatFor(sessionId);
      if (!chat || !adapter) return;
      for (const chunk of adapter.chunkResponse(text)) {
        void send(chat, chunk);
      }
    },

    turnComplete(sessionId, summary) {
      const chat = chatFor(sessionId);
      progressMsg.delete(sessionId);
      if (!chat) return;
      const lines: string[] = [];
      if (summary.changedFilesSummary) lines.push(`Files: ${summary.changedFilesSummary.slice(0, 300)}`);
      if (summary.error) lines.push(`* ${summary.error.slice(0, 200)}`);
      void send(chat, lines.length > 0 ? lines.join("\n") : "* Pi turn complete");
    },

    busy(sessionId, reason) {
      const chat = chatFor(sessionId);
      if (chat) void send(chat, `* Pi busy: ${reason}`);
    },

    retry(sessionId, reason) {
      const chat = chatFor(sessionId);
      if (chat) void send(chat, `* ${reason}`);
    },

    notResumable(sessionId, capability, reason) {
      const chat = chatFor(sessionId);
      if (chat) void send(chat, `* Pi session not resumable (${capability}): ${reason}`);
    },
  };
  return sink;
}
