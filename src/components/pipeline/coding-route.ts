/**
 * coding-route.ts — #1635 pre-command routing boundary for interactive Pi
 * coding sessions.
 *
 * Inserted between sessionSelectionMiddleware and commandMiddleware. For a
 * message whose active session is a coding session it claims ordinary text and
 * the coding-owned controls `/stop`, `/ctrlc`, `/steer`, `/compact`, and `//`
 * pass-through. Global `/coding`, `/session`, and unrelated commands proceed
 * to the existing command registry.
 *
 * Placement is load-bearing (R5): claiming happens BEFORE
 * commandMiddleware (generic handlers would consume the controls),
 * before the busy/paused guards (Pi's own queue is authoritative — routing a
 * mid-turn message through the abTARS busy queue would deliver it twice), and
 * before BeforeMessage (which is what makes the no-abmind contract structural
 * rather than a set of opt-outs).
 */

import type { Middleware } from "./middleware.js";
import type { PiCodingSessionService } from "../pi-executor/pi-coding-session-service.js";

let service: PiCodingSessionService | null = null;

export function setCodingRouteService(svc: PiCodingSessionService | null): void {
  service = svc;
}

const CODING_CONTROLS = new Set(["/stop", "/ctrlc", "/steer", "/compact"]);

export const codingRouteMiddleware: Middleware = async (ctx, next) => {
  const svc = service;
  if (!svc) return next();

  const sessionId = ctx.sessionId;
  if (!sessionId) return next();

  // The active session must BE a coding session; anything else passes through.
  const rec = svc.getSession(sessionId, ctx.userId);
  if (!rec) return next();

  const text = ctx.text.trim();
  const cmd = text.split(/\s/)[0]!.toLowerCase();

  // Global commands keep working inside a coding session.
  if (cmd === "/coding" || cmd === "/session") return next();

  const isOrdinary = !text.startsWith("/");
  const isCodingControl = CODING_CONTROLS.has(cmd);
  const isPassThrough = text.startsWith("//");
  if (!isOrdinary && !isCodingControl && !isPassThrough) return next();

  // Claimed — return before busy guards and BeforeMessage.
  ctx.handled = true;

  const leaseOwner = `${ctx.msg.platform}:${ctx.chatId}`;
  if (isPassThrough) {
    const result = await svc.passThrough(sessionId, text.slice(1), ctx.userId);
    await replyForStartResult(ctx, result, "command passed to Pi");
    return;
  }
  if (cmd === "/stop" || cmd === "/ctrlc") {
    const stopped = await svc.stop(sessionId, ctx.userId);
    if (!stopped) await ctx.reply("No active Pi turn to stop.");
    else await ctx.reply("* Stopping Pi turn (session stays alive)");
    return;
  }
  if (cmd === "/steer") {
    const instruction = text.replace(/^\/steer\s*/i, "").trim();
    if (!instruction) { await ctx.reply("Usage: /steer <instruction>"); return; }
    const result = await svc.steer(sessionId, instruction, ctx.userId);
    await replyForStartResult(ctx, result, "steering Pi");
    return;
  }
  if (cmd === "/compact") {
    const instructions = text.replace(/^\/compact\s*/i, "").trim() || undefined;
    const result = await svc.compactSession(sessionId, instructions, ctx.userId);
    if (!result.ok) await ctx.reply(`Pi compaction failed: ${result.message}`);
    return;
  }
  // Ordinary text: a pending UI request gets the correlated reply; an
  // idle/interrupted session starts a turn; a running turn receives follow_up
  // (Pi's own queue is authoritative — never double-queue).
  let result: import("../pi-executor/pi-coding-session-service.js").TurnStartResult;
  if (rec.state === "awaiting_input" && rec.pendingRequestId) {
    const ok = await svc.reply(sessionId, rec.pendingRequestId, text, ctx.userId);
    await ctx.reply(ok.ok ? `* Answer submitted to Pi.` : `* Pi input reply failed (${ok.reason ?? "unknown"})`);
    return;
  }
  result = rec.state === "running"
    ? await svc.followUp(sessionId, text, ctx.userId)
    : await svc.startTurn({ sessionId, text, ownerPrincipal: ctx.userId, leaseOwner });
  await replyForStartResult(ctx, result, "Pi is working");
};

function replyForStartResult(
  ctx: import("./middleware.js").MessageContext,
  result: import("../pi-executor/pi-coding-session-service.js").TurnStartResult,
  startedWording: string,
): Promise<number | string | undefined> {
  switch (result.kind) {
    case "started":
      return ctx.reply(`* ${startedWording}`);
    case "busy":
      return ctx.reply(`* Pi busy: ${result.reason}`);
    case "retry":
      return ctx.reply(`* ${result.reason}`);
    case "not_resumable":
      return ctx.reply(`* Pi session not resumable (${result.capability}): ${result.reason}. Use /coding end and /coding new to start fresh.`);
    case "error":
      return ctx.reply(`* Pi error: ${result.reason}`);
  }
}
