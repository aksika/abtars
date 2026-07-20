import { handleNLMCommand } from "../nlm-command-handler.js";
import type { CommandContext } from "./types.js";


export async function handleMemory(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.memoryRuntime.state !== "ready") { await ctx.reply("🧠 Memory is unavailable."); return true; }
  const stats = await ctx.memoryRuntime.getStatus({ userId: ctx.userId });
  const dbMb = (stats.dbSizeBytes / (1024 * 1024)).toFixed(1);
  const types = Object.entries(stats.extractedByType).map(([t, n]) => `  ${t}: ${n}`).join("\n") || "  (none)";
  const msg = [
    "🧠 Memory Status", "",
    `💬 Raw messages: ${stats.totalMessages}`,
    `🧩 Extracted memories: ${stats.extractedMemories}`, types,
    `🔑 Preserved keywords: ${stats.preservedKeywords}`, "",
    `📄 Consolidations:`,
    `  daily: ${stats.consolidationFiles.daily}`,
    `  weekly: ${stats.consolidationFiles.weekly}`,
    `  quarterly: ${stats.consolidationFiles.quarterly}`, "",
    `📄 Ingested documents: ${stats.ingestedDocuments}`,
    `💾 DB size: ${dbMb} MB`, "",
    `📚 Layer 6 (NotebookLM): ${ctx.nlmConfig.enabled ? "enabled" : "disabled"}`,
  ].join("\n");
  await ctx.reply(msg);
  return true;
}

export async function handleFacts(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.memoryRuntime.state === "ready") {
    const facts = await ctx.memoryRuntime.getCoreKnowledge({ userId: ctx.userId });
    await ctx.reply(facts ? `📋 Core knowledge:\n\n${facts}` : "📋 No core knowledge yet.");
  } else {
    await ctx.reply("🧠 Memory is disabled.");
  }
  return true;
}

export async function handleNlm(text: string, ctx: CommandContext): Promise<boolean> {
  const args = text.slice("/nlm".length).trim();
  const result = await handleNLMCommand(args, ctx.nlmConfig as any);
  await ctx.reply(result.text);
  return true;
}
