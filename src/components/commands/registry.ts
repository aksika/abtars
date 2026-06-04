import { logInfo } from "../logger.js";
import { resetAndPrepare } from "../message-pipeline.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { CommandContext, CommandHandler } from "./types.js";

const TAG = "cmd_registry";

const exactCommands: Record<string, CommandHandler> = {};
const prefixCommands: Array<{ prefix: string; handler: CommandHandler }> = [];
const KNOWN_COMMANDS = new Set<string>();

const NON_MASTER_COMMANDS = new Set(["/new", "/reset", "/stop", "/ctrlc", "/status", "/help", "/whoami"]);

export function registerExact(name: string, handler: CommandHandler): void {
  exactCommands[name] = handler;
  KNOWN_COMMANDS.add(name);
}

export function registerPrefix(prefix: string, handler: CommandHandler): void {
  prefixCommands.push({ prefix, handler });
  KNOWN_COMMANDS.add(prefix.split(" ")[0]!);
}

/** Register an additional exact-match command (used by capability system). */
export function registerCommand(name: string, handler: CommandHandler): void {
  registerExact(name, handler);
}

/** Returns true if command was handled. */
export async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const isMaster = !ctx.userId || ctx.userId === "master" ||
    (await import("../user-registry.js")).loadUsers().byUserId.get(ctx.userId)?.role === "master";

  if (!isMaster) {
    const cmd = text.split(/\s/)[0]!;
    if (cmd.startsWith("/") && !NON_MASTER_COMMANDS.has(cmd)) {
      await ctx.reply("⛔ Owner-only command.");
      return true;
    }
  }

  const exact = exactCommands[text];
  if (exact) return exact(text, ctx);

  for (const { prefix, handler } of prefixCommands) {
    if (text.startsWith(prefix)) return handler(text, ctx);
  }

  const firstWord = text.split(/\s/)[0]!;
  if (text !== firstWord) {
    const byFirstWord = exactCommands[firstWord];
    if (byFirstWord) return byFirstWord(text, ctx);
  }

  if (text.startsWith("/") && /^\/\w+/.test(text) && !text.startsWith("//")) {
    const cmd = text.split(/\s/)[0]!;
    if (!KNOWN_COMMANDS.has(cmd)) {
      await ctx.reply(`❓ Unknown command: ${cmd}\nType /help for available commands.`);
      return true;
    }
  }

  return false;
}

/** Core new-session logic — reusable from model-switch paths. */
export async function triggerNewSession(ctx: CommandContext, reason = "new-session"): Promise<void> {
  const { hasHooks, fire: fireHook } = await import("../hooks/hook-system.js");
  if (hasHooks("SessionEnd")) {
    await fireHook("SessionEnd", { event: "SessionEnd", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason }).catch(err => logAndSwallow(TAG, "fireHook session", err));
  }
  await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
  await resetAndPrepare({
    transport: ctx.transport, sessionKey: ctx.sessionKey,
    reason, sessions: ctx.sessions, conversationBuffer: ctx.conversationBuffer, bufKey: ctx.bufKey,
  });
  if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.userId);
  if (hasHooks("SessionStart")) {
    await fireHook("SessionStart", { event: "SessionStart", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason }).catch(err => logAndSwallow(TAG, "fireHook session", err));
  }
}

/** Core reset-session logic — clears cache, rebuilds transport, resets session. */
export async function triggerResetSession(ctx: CommandContext): Promise<void> {
  const { hasHooks, fire: fireHook } = await import("../hooks/hook-system.js");
  if (hasHooks("SessionEnd")) {
    await fireHook("SessionEnd", { event: "SessionEnd", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason: "reset-transport" }).catch(err => logAndSwallow(TAG, "fireHook session", err));
  }
  await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
  const { clearTransportCache } = await import("../transport-config.js");
  clearTransportCache();
  if (ctx.rebuildTransport) await ctx.rebuildTransport();
  await resetAndPrepare({
    transport: ctx.transport, sessionKey: ctx.sessionKey,
    reason: "reset-transport", sessions: ctx.sessions, conversationBuffer: ctx.conversationBuffer, bufKey: ctx.bufKey,
  });
  if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.userId);
  if (hasHooks("SessionStart")) {
    await fireHook("SessionStart", { event: "SessionStart", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason: "reset-transport" }).catch(err => logAndSwallow(TAG, "fireHook session", err));
  }
}

let _wakeInhibitPid: number | null = null;

/** Kill the wake inhibitor process (called before hw sleep). */
export function killWakeInhibit(): void {
  if (_wakeInhibitPid) {
    try { process.kill(_wakeInhibitPid); } catch (err) { logAndSwallow("command_handlers", "op", err); }
    logInfo("wakeup", `Killed wake inhibitor pid=${_wakeInhibitPid}`);
    _wakeInhibitPid = null;
  }
}

export function setWakeInhibitPid(pid: number): void {
  _wakeInhibitPid = pid;
}
