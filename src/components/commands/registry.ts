import { logInfo } from "../logger.js";
import { resetAndPrepare } from "../message-pipeline.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { CommandContext, CommandHandler } from "./types.js";

const TAG = "cmd_registry";

const exactCommands: Record<string, CommandHandler> = {};
const prefixCommands: Array<{ prefix: string; handler: CommandHandler }> = [];
const KNOWN_COMMANDS = new Set<string>();

const NON_MASTER_COMMANDS = new Set([
  "/status", "/help", "/whoami", "/doctor", "/software", "/update",
  "/models", "/model", "/skills", "/skill", "/facts", "/tasks", "/task",
  "/usage", "/openrouter", "/session", "/hooks", "/memory", "/kanban",
  "/heartbeat", "/reset", "/stop", "/ctrlc",
]);

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
      // Fuzzy match: auto-execute if Levenshtein ≤ 2
      const match = fuzzyMatch(cmd);
      if (match) {
        const corrected = text.replace(cmd, match);
        return handleCommand(corrected, ctx);
      }
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

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!;
      d[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[j]!, d[j - 1]!);
      prev = tmp;
    }
  }
  return d[n]!;
}

function fuzzyMatch(cmd: string): string | null {
  let best: string | null = null;
  let bestDist = 3; // threshold: ≤ 2
  for (const known of KNOWN_COMMANDS) {
    const dist = levenshtein(cmd, known);
    if (dist < bestDist) { best = known; bestDist = dist; }
  }
  return best;
}
