/**
 * /session command handler (#510).
 */
import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { parseSessionType, typeLabel, sessionType } from "../spin-types.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd:session";

export async function handleSession(text: string, ctx: CommandContext): Promise<boolean> {
  const args = text.replace(/^\/session\s*/i, "").trim();

  // /session (no args) → list
  if (!args) {
    await ctx.reply(ctx.sessionManager.formatList(ctx.userId, ctx.platform));
    return true;
  }

  // /session new [type]
  if (args.startsWith("new")) {
    const typeArg = args.slice(3).trim();
    const type = typeArg ? parseSessionType(typeArg) : "A";
    if (!type) {
      await ctx.reply(`Unknown session type: ${typeArg}. Available: browse, code, task`);
      return true;
    }
    const result = ctx.sessionManager.createSession(ctx.userId, ctx.platform, type);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    await ctx.reply(`✅ Session #${result.shortIndex} (${typeLabel(sessionType(result))}) created.`);
    logInfo(TAG, `New session ${result.id} for ${ctx.userId}`);
    return true;
  }

  // /session end [#]
  if (args.startsWith("end")) {
    const indexStr = args.slice(3).trim();
    const index = indexStr ? parseInt(indexStr, 10) : undefined;
    if (indexStr && isNaN(index!)) { await ctx.reply("Usage: /session end [#]"); return true; }
    const result = ctx.sessionManager.endSession(ctx.userId, ctx.platform, index);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    await ctx.reply(`✅ Session #${result.shortIndex} (${typeLabel(sessionType(result))}) ended.`);
    logInfo(TAG, `Ended session ${result.id}`);
    return true;
  }

  // /session kill #
  if (args.startsWith("kill")) {
    const indexStr = args.slice(4).trim();
    const index = parseInt(indexStr, 10);
    if (isNaN(index)) { await ctx.reply("Usage: /session kill <#>"); return true; }
    const result = ctx.sessionManager.killSession(ctx.userId, ctx.platform, index);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    // Wipe messages from abmind
    if (ctx.memory) {
      try {
        const db = (ctx.memory as any).db;
        if (db) db.prepare("DELETE FROM messages WHERE session_id = ?").run(result.id);
      } catch (err) { logAndSwallow(TAG, "delete session messages", err); }
    }
    await ctx.reply(`🗑️ Session #${result.shortIndex} (${typeLabel(sessionType(result))}) killed.`);
    logInfo(TAG, `Killed session ${result.id}`);
    return true;
  }

  // /session pause [#]
  if (args.startsWith("pause")) {
    const indexStr = args.slice(5).trim();
    const index = indexStr ? parseInt(indexStr, 10) : undefined;
    if (indexStr && isNaN(index!)) { await ctx.reply("Usage: /session pause [#]"); return true; }
    const result = ctx.sessionManager.pauseSession(ctx.userId, ctx.platform, index);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    await ctx.reply(`⏸ Session #${result.shortIndex} (${typeLabel(sessionType(result))}) paused.`);
    logInfo(TAG, `Paused session ${result.id}`);
    return true;
  }

  // /session resume [#]
  if (args.startsWith("resume")) {
    const indexStr = args.slice(6).trim();
    const index = indexStr ? parseInt(indexStr, 10) : undefined;
    if (indexStr && isNaN(index!)) { await ctx.reply("Usage: /session resume [#]"); return true; }
    const result = ctx.sessionManager.resumeSession(ctx.userId, ctx.platform, index);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    await ctx.reply(`▶️ Session #${result.shortIndex} (${typeLabel(sessionType(result))}) resumed.`);
    logInfo(TAG, `Resumed session ${result.id}`);
    return true;
  }

  // /session <#> → switch
  const index = parseInt(args, 10);
  if (!isNaN(index)) {
    const result = ctx.sessionManager.switchSession(ctx.userId, ctx.platform, index);
    if (typeof result === "string") { await ctx.reply(`❌ ${result}`); return true; }
    await ctx.reply(`🔀 Switched to session #${result.shortIndex} (${typeLabel(sessionType(result))}).`);
    logInfo(TAG, `Switched to session ${result.id}`);
    return true;
  }

  await ctx.reply("Usage: /session [new [browse|code|task] | end [#] | kill <#> | pause [#] | resume [#] | <#>]");
  return true;
}
