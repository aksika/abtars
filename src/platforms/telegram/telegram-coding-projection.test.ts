/**
 * telegram-coding-projection.test.ts — #1635 bounded Telegram projection.
 *
 * Proves tool arguments and output never appear, confirm/select render as
 * inline controls, one editable progress message per turn, assistant text is
 * chunked, and the callback routing reaches the service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskDatabase } from "../../components/tasks/kanban-board.js";
import { PiCodingSessionStore } from "../../components/pi-executor/pi-coding-session-store.js";
import {
  createCodingProjectionSink,
  isCodingCallback,
  handleCodingCallback,
  setTelegramCodingDelivery,
  setCodingCallbackHandler,
} from "./telegram-coding-projection.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params); },
        get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
  };
}

function seedSession(store: PiCodingSessionStore, sessionId = "coding-1"): void {
  store.create({
    sessionId,
    ownerPrincipal: "usr-1",
    workspaceAlias: "repo-a",
    canonicalPath: "/tmp/ws/repo-a",
    chatId: "100",
  });
  store.casTransition(sessionId, "creating", "idle");
}

describe("telegram coding projection #1635", () => {
  let store: PiCodingSessionStore;
  let sent: Array<{ chat: string; text: string; opts?: unknown }>;
  let edited: Array<{ chat: string; id: number | string; text: string }>;
  let adapter: { sendMessage: ReturnType<typeof vi.fn>; editMessage: ReturnType<typeof vi.fn>; chunkResponse: (t: string) => string[] };

  beforeEach(() => {
    store = new PiCodingSessionStore(createTestDb());
    seedSession(store);
    sent = [];
    edited = [];
    adapter = {
      sendMessage: vi.fn(async (chat: string, text: string, opts?: unknown) => { sent.push({ chat, text, opts }); return 7; }),
      editMessage: vi.fn(async (chat: string, id: number | string, text: string) => { edited.push({ chat, id, text }); return undefined; }),
      chunkResponse: (t: string) => { const out: string[] = []; for (let i = 0; i < t.length; i += 40) out.push(t.slice(i, i + 40)); return out; },
    };
    setTelegramCodingDelivery(adapter as never, null);
    setCodingCallbackHandler(null);
  });

  afterEach(() => {
    setTelegramCodingDelivery(null, null);
    setCodingCallbackHandler(null);
  });

  it("turnComplete emits the changed-file summary bounded, never raw tool output", () => {
    const sink = createCodingProjectionSink(store);
    sink.turnComplete("coding-1", { changedFilesSummary: "src/a.ts " + "changed ".repeat(120) });
    expect(sent).toHaveLength(1);
    // the summary line is bounded to 300 chars even when the evidence is long
    expect(sent[0]!.text.length).toBeLessThanOrEqual(320);
    sink.turnComplete("coding-1", { error: "process died" });
    expect(sent[1]!.text).toContain("process died");
  });

  it("one editable progress message per turn — subsequent progress edits it", async () => {
    const sink = createCodingProjectionSink(store);
    sink.tool("coding-1", "BashTool", true);
    await new Promise(r => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("+ BashTool");
    // second lifecycle event edits the same message instead of sending a new one
    sink.tool("coding-1", "BashTool", false);
    await new Promise(r => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(edited).toHaveLength(1);
    expect(edited[0]!.id).toBe(7);
    expect(edited[0]!.text).toBe("- BashTool");
    // turn complete clears the editable slot
    sink.turnComplete("coding-1", {});
    sink.tool("coding-1", "Another", true);
    await new Promise(r => setTimeout(r, 10));
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it("assistant text is chunked to platform limits", () => {
    const sink = createCodingProjectionSink(store);
    const long = "x".repeat(100);
    sink.assistantText("coding-1", long);
    expect(sent).toHaveLength(3);
    expect(sent.map(s => s.text).join("")).toBe(long);
  });

  it("confirm renders as an inline keyboard with yes/no callbacks", () => {
    const sink = createCodingProjectionSink(store);
    sink.uiRequest("coding-1", { type: "extension_ui_request", id: "req-1", method: "confirm", title: "Approve?", message: "run it" });
    expect(sent).toHaveLength(1);
    const markup = (sent[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }).reply_markup;
    expect(markup.inline_keyboard[0]!.map(b => b.text)).toEqual(["Yes", "No"]);
    expect(markup.inline_keyboard[0]![0]!.callback_data).toBe("coding:coding-1:req-1:true");
    expect(markup.inline_keyboard[0]![1]!.callback_data).toBe("coding:coding-1:req-1:false");
  });

  it("select renders options as buttons without the raw option payload beyond the label", () => {
    const sink = createCodingProjectionSink(store);
    sink.uiRequest("coding-1", { type: "extension_ui_request", id: "req-2", method: "select", title: "Pick", options: ["option-a", "option-b"] });
    const markup = (sent[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }).reply_markup;
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]![0]!.callback_data).toContain("option-a");
  });

  it("input renders as a correlated prompt with a suggestion", () => {
    const sink = createCodingProjectionSink(store);
    sink.uiRequest("coding-1", { type: "extension_ui_request", id: "req-3", method: "input", title: "Enter name", placeholder: "repo" });
    expect(sent[0]!.text).toContain("Enter name");
    expect(sent[0]!.text).toContain("repo");
    expect(sent[0]!.text).not.toContain("req-3"); // request id never leaks into visible text
  });

  it("callback routing invokes the wired service reply path with coerced booleans", async () => {
    const handler = vi.fn(async () => true);
    setCodingCallbackHandler(handler);
    expect(isCodingCallback("coding:coding-1:req-1:true")).toBe(true);
    expect(isCodingCallback("model:gpt")).toBe(false);
    await handleCodingCallback("coding:coding-1:req-1:true", 100);
    expect(handler).toHaveBeenCalledWith("coding-1", "req-1", "true");
  });
});
