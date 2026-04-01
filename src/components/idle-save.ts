import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn } from "./logger.js";
import type { IKiroTransport } from "./kiro-transport.js";
import { localDate } from "./env-utils.js";

const CHAT_SAVE_IDLE_MS = 10 * 60 * 1000;

/**
 * Manages idle-save timers: after 10 min of inactivity per session,
 * saves the kiro-cli conversation transcript to the working directory.
 */
export class IdleSave {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly transport: IKiroTransport;
  private readonly memoryDir: string;
  private readonly enabled: boolean;

  constructor(transport: IKiroTransport, memoryDir: string, memoryEnabled: boolean) {
    this.transport = transport;
    this.memoryDir = memoryDir;
    this.enabled = memoryEnabled;
  }

  getTimers(): Map<string, ReturnType<typeof setTimeout>> {
    return this.timers;
  }

  reset(sessionKey: string, chatId: number): void {
    const existing = this.timers.get(sessionKey);
    if (existing) clearTimeout(existing);
    this.timers.set(sessionKey, setTimeout(() => {
      this.timers.delete(sessionKey);
      this.save(sessionKey, chatId);
    }, CHAT_SAVE_IDLE_MS));
  }

  async save(sessionKey: string, chatId: number): Promise<void> {
    if (!this.enabled) return;
    // /chat save only works on tmux transport, not ACP
    if (!("sendKeys" in this.transport)) return;
    const today = localDate();
    const dir = join(this.memoryDir, "working", today);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `transcript_${chatId}.chat`);
    try {
      await this.transport.sendPrompt(sessionKey, `/chat save ${dest}`);
      logInfo("idle-save", `Chat saved to ${dest}`);
    } catch (e) {
      logWarn("idle-save", `Chat save failed: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
