import type { CommandContext } from "./types.js";
import { PiRunService } from "../pi-executor/pi-run-service.js";
import type { PiRunView, PiRunOrigin } from "../pi-executor/types.js";

let piService: PiRunService | null = null;

export function setPiService(service: PiRunService | null): void {
  piService = service;
}

function getService(_ctx: CommandContext): PiRunService {
  if (!piService) throw new Error("Pi executor is not available");
  return piService;
}

export async function handlePiRun(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const args = text.replace(/^\/pi\s+run\s*/i, "").trim();
    const wsMatch = args.match(/^--workspace\s+(\S+)/);
    if (!wsMatch) {
      await ctx.reply("Usage: /pi run --workspace <alias> <goal>\nExample: /pi run --workspace abtars 'Add error handling'");
      return true;
    }
    const workspaceAlias = wsMatch[1]!;
    const goal = args.replace(wsMatch[0], "").trim();
    if (!goal) { await ctx.reply("Goal is required"); return true; }

    const result = await svc.run({
      goal,
      workspaceAlias,
      owner: { principalId: ctx.userId, origin: "user" as PiRunOrigin, platform: ctx.platform, chatId: String(ctx.chatId) },
    }, { userId: ctx.userId });

    await ctx.reply(`✅ Pi run created:\n  Run: \`${result.runId}\`\n  Card: #${result.cardId}\n  Session: \`${result.sessionId}\`\n  Generation: ${result.generation}\n\nUse /pi status ${result.runId} to track.`);
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiStatus(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const runId = text.replace(/^\/pi\s+(?:status|get)\s*/i, "").trim();
    if (!runId) { await ctx.reply("Usage: /pi status <runId>"); return true; }
    const view = svc.get(runId, { userId: ctx.userId });
    await ctx.reply(formatRunView(view));
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiList(_text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const views = svc.list({ ownerPrincipalId: ctx.userId }, { userId: ctx.userId });
    if (views.length === 0) { await ctx.reply("No Pi runs found."); return true; }
    const lines = views.slice(0, 10).map((v, i) =>
      `${i + 1}. \`${v.runId}\` — ${v.status} (${v.workspaceAlias}) [gen ${v.generation}]`
    );
    await ctx.reply(`Pi runs:\n${lines.join("\n")}${views.length > 10 ? `\n...and ${views.length - 10} more` : ""}`);
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiReply(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const args = text.replace(/^\/pi\s+reply\s*/i, "").trim();
    const parts = args.match(/^(\S+)\s+(\S+)\s+(.+)/);
    if (!parts) { await ctx.reply("Usage: /pi reply <runId> <requestId> <value>"); return true; }
    const view = await svc.reply(parts[1]!, parts[2]!, parts[3]!, { userId: ctx.userId });
    await ctx.reply(formatRunView(view));
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiSteer(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const args = text.replace(/^\/pi\s+steer\s*/i, "").trim();
    const parts = args.match(/^(\S+)\s+(.+)/);
    if (!parts) { await ctx.reply("Usage: /pi steer <runId> <instruction>"); return true; }
    const view = await svc.steer(parts[1]!, parts[2]!, { userId: ctx.userId });
    await ctx.reply(formatRunView(view));
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiCancel(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const runId = text.replace(/^\/pi\s+cancel\s*/i, "").trim();
    if (!runId) { await ctx.reply("Usage: /pi cancel <runId>"); return true; }
    const view = await svc.cancel(runId, { userId: ctx.userId });
    await ctx.reply(formatRunView(view));
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function handlePiResume(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const runId = text.replace(/^\/pi\s+resume\s*/i, "").trim();
    if (!runId) { await ctx.reply("Usage: /pi resume <runId>"); return true; }
    const ref = await svc.resume(runId, { userId: ctx.userId });
    await ctx.reply(`🔄 Pi run resumed:\n  Run: \`${ref.runId}\`\n  Card: #${ref.cardId}\n  Session: \`${ref.sessionId}\`\n  Generation: ${ref.generation}`);
    return true;
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

function formatRunView(view: PiRunView): string {
  const lines = [
    `Run: \`${view.runId}\``,
    `Status: ${view.status}`,
    `Workspace: ${view.workspaceAlias}`,
    `Generation: ${view.generation}`,
    `Created: ${view.createdAt}`,
  ];
  if (view.sessionId) lines.push(`Session: \`${view.sessionId}\``);
  if (view.lastRpcActivityAt) lines.push(`Last activity: ${view.lastRpcActivityAt}`);
  if (view.modelId) lines.push(`Model: ${view.modelProvider}/${view.modelId}`);
  if (view.pendingRequestId) lines.push(`Pending input: \`${view.pendingRequestId}\` (${view.pendingRequestType})`);
  if (view.resultSummary) lines.push(`Result: ${view.resultSummary.slice(0, 500)}`);
  if (view.changedFilesSummary) lines.push(`Files: ${view.changedFilesSummary.slice(0, 300)}`);
  if (view.error) lines.push(`Error: ${view.error}`);
  return lines.join("\n");
}
