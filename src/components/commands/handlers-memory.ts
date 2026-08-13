import { handleNLMCommand } from "../nlm-command-handler.js";
import type { CommandContext } from "./types.js";

/** #1515: deterministic empty-state line for the owner-scoped question list. */
export const DREAM_QUESTIONS_EMPTY = "No pending memory questions.";

function formatQuestionAge(createdAt: number): string {
  const hours = Math.floor((Date.now() - createdAt) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** #1515: /memory questions — owner-scoped active question list. */
export async function handleMemoryQuestions(ctx: CommandContext): Promise<boolean> {
  if (ctx.memoryRuntime.state !== "ready" || !ctx.memoryRuntime.supports("dreamQuestions")) {
    await ctx.reply("Memory questions are unavailable.");
    return true;
  }
  try {
    const { questions } = await ctx.memoryRuntime.dreamQuestions.list(ctx.userId);
    if (questions.length === 0) {
      await ctx.reply(DREAM_QUESTIONS_EMPTY);
      return true;
    }
    const lines = questions.map(q => `  [${q.status}] ${q.id} (${formatQuestionAge(q.createdAt)}): ${q.question}`);
    await ctx.reply(`Memory questions (${questions.length}):\n${lines.join("\n")}`);
    return true;
  } catch (err) {
    await ctx.reply("Memory questions are temporarily unavailable.");
    return true;
  }
}

/** #1515: /memory questions dismiss <id> — owner-scoped single-row CAS. */
export async function handleMemoryQuestionsDismiss(id: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.memoryRuntime.state !== "ready" || !ctx.memoryRuntime.supports("dreamQuestions")) {
    await ctx.reply("Memory questions are unavailable.");
    return true;
  }
  if (!id || id.length > 128) {
    await ctx.reply("Invalid question id.");
    return true;
  }
  try {
    const result = await ctx.memoryRuntime.dreamQuestions.dismiss(ctx.userId, id);
    switch (result.status) {
      case "dismissed":
        await ctx.reply(`Dismissed question ${id}.`);
        break;
      case "not_found":
        await ctx.reply("Question not found.");
        break;
      case "already_terminal":
        await ctx.reply(`Question ${id} is already resolved or dismissed.`);
        break;
    }
    return true;
  } catch (err) {
    await ctx.reply("Memory questions are temporarily unavailable.");
    return true;
  }
}

export async function handleMemory(text: string, ctx: CommandContext): Promise<boolean> {
  const args = text.slice("/memory".length).trim();
  if (args === "questions") {
    return handleMemoryQuestions(ctx);
  }
  const dismissMatch = /^questions\s+dismiss(?:\s+(\S+))?$/.exec(args);
  if (dismissMatch) return handleMemoryQuestionsDismiss(dismissMatch[1] ?? "", ctx);
  if (args.length > 0) {
    // Unknown subcommand — keep the bare command's exact output for /memory
    // itself; any unknown suffix behaves like the bare command.
    // (No output change for bare /memory.)
  }
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
