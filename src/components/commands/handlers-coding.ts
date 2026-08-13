/**
 * handlers-coding.ts — #1635 /coding command handlers.
 *
 * Owner-only creation, allowlisted workspace alias resolved canonically at
 * creation and at every resume (R6). `/coding` with no arguments resumes the
 * owner's single most recent session or shows a bounded chooser.
 */

import type { CommandContext } from "./types.js";
import type { PiCodingSessionService } from "../pi-executor/pi-coding-session-service.js";

let service: PiCodingSessionService | null = null;

export function setCodingCommandService(svc: PiCodingSessionService | null): void {
  service = svc;
}

function getService(_ctx: CommandContext): PiCodingSessionService {
  if (!service) throw new Error("Pi coding sessions are not available");
  return service;
}

const CHOOSER_MAX = 5;

export async function handleCoding(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const svc = getService(ctx);
    const args = text.replace(/^\/coding\s*/i, "").trim();

    if (!args || args === "resume") {
      return resumeMostRecent(svc, ctx, args === "resume" ? text.replace(/^\/coding\s+resume\s*/i, "").trim() : "");
    }

    if (args === "new" || args.startsWith("new ")) {
      const alias = args.slice("new".length).trim();
      if (!alias) {
        await ctx.reply("Usage: /coding new <workspace-alias>");
        return true;
      }
      const result = svc.createCodingSession({
        ownerPrincipal: ctx.userId,
        workspaceAlias: alias,
        chatId: String(ctx.chatId),
      });
      const activated = await activateSession(svc, ctx, result.sessionId);
      await ctx.reply(
        `✓ Coding session created:\n  Session: \`${result.sessionId}\`\n  Workspace: ${alias}\n${activated ? "Active — send your first message." : ""}`
      );
      return true;
    }

    if (args === "status" || args.startsWith("status ")) {
      const sessions = svc.listForOwner(ctx.userId);
      if (sessions.length === 0) {
        await ctx.reply("No coding sessions. Start one with /coding new <workspace-alias>.");
        return true;
      }
      const lines = sessions.slice(0, 10).map((s, i) =>
        `${i + 1}. \`${s.sessionId}\` — ${s.state} (${s.workspaceAlias}) [gen ${s.runtimeGeneration}${s.resumeCapability !== "available" ? `, ${s.resumeCapability}` : ""}]`
      );
      await ctx.reply(`Coding sessions:\n${lines.join("\n")}${sessions.length > 10 ? `\n...and ${sessions.length - 10} more` : ""}`);
      return true;
    }

    if (args === "off") {
      const sessions = svc.listForOwner(ctx.userId);
      if (sessions.length === 0) { await ctx.reply("No coding session is active."); return true; }
      const deactivated = await deactivateCoding(svc, ctx, sessions[0]!.sessionId);
      await ctx.reply(deactivated ? "Coding session deactivated — back to the main session." : "Coding session not found.");
      return true;
    }

    if (args === "end" || args.startsWith("end ")) {
      const target = args.replace(/^end\s*/i, "").trim();
      const sessions = svc.listForOwner(ctx.userId);
      const sessionId = target || sessions[0]?.sessionId;
      if (!sessionId) { await ctx.reply("No coding session to end."); return true; }
      const current = svc.getSession(sessionId, ctx.userId);
      const wasActive = current && ["starting", "running", "awaiting_input", "resuming"].includes(current.state);
      const ended = svc.endSession(sessionId, ctx.userId);
      await ctx.reply(ended
        ? wasActive ? "Coding session teardown requested; the transcript will be preserved." : "Coding session ended (transcript preserved on disk)."
        : "Coding session not found.");
      return true;
    }

    await ctx.reply("Usage: /coding | /coding new <alias> | /coding status | /coding off | /coding resume | /coding end");
    return true;
  } catch (err) {
    await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

async function resumeMostRecent(svc: PiCodingSessionService, ctx: CommandContext, explicitId: string): Promise<boolean> {
  if (explicitId) {
    const rec = svc.getSession(explicitId, ctx.userId);
    if (!rec) { await ctx.reply("Coding session not found."); return true; }
    const activated = await activateSession(svc, ctx, explicitId);
    await ctx.reply(activated ? `✓ Resumed coding session (${rec.workspaceAlias}).` : "Failed to activate the session.");
    return true;
  }

  const sessions = svc.listForOwner(ctx.userId).filter(s => s.state !== "ended");
  if (sessions.length === 0) {
    await ctx.reply("No coding sessions. Start one with /coding new <workspace-alias>.");
    return true;
  }
  if (sessions.length === 1) {
    const rec = sessions[0]!;
    const activated = await activateSession(svc, ctx, rec.sessionId);
    await ctx.reply(activated
      ? `✓ Resumed coding session (${rec.workspaceAlias}) — ${rec.state === "interrupted" ? "previous turn was interrupted; send a message to continue." : "send a message to continue."}`
      : "Failed to activate the session.");
    return true;
  }
  // bounded chooser
  const lines = sessions.slice(0, CHOOSER_MAX).map((s, i) =>
    `${i + 1}. \`${s.sessionId}\` — ${s.state} (${s.workspaceAlias})`
  );
  await ctx.reply(`Multiple coding sessions — resume one:\n${lines.join("\n")}\n\nUse /coding resume <sessionId> or /session <#> to switch.`);
  return true;
}

async function activateSession(svc: PiCodingSessionService, ctx: CommandContext, sessionId: string): Promise<boolean> {
  try {
    return svc.activate(sessionId, ctx.userId);
  } catch {
    return false;
  }
}

async function deactivateCoding(svc: PiCodingSessionService, ctx: CommandContext, sessionId: string): Promise<boolean> {
  try {
    return await svc.deactivate(sessionId, ctx.userId);
  } catch {
    return false;
  }
}

/** Status line helper for the /help listing. */
export function codingHelpText(): string {
  return "/coding — interactive Pi coding session (new <alias> | status | off | resume | end)";
}
