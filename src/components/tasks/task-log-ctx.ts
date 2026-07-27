export interface TaskLogCtx {
  task?: string;
  run?: string;
  attempt?: number;
  card?: number;
  session?: string;
  exec?: string;
}

export function fmtLogCtx(ctx: TaskLogCtx): string {
  const parts: string[] = [];
  if (ctx.task) parts.push(`task=${ctx.task}`);
  if (ctx.run) parts.push(`run=${ctx.run}`);
  if (ctx.attempt) parts.push(`attempt=${ctx.attempt}`);
  if (ctx.card) parts.push(`card=${ctx.card}`);
  if (ctx.session) parts.push(`session=${ctx.session}`);
  if (ctx.exec) parts.push(`exec=${ctx.exec}`);
  return parts.join(" ");
}

/** Emit compact correlation-only events; payloads never belong in these helpers. */
export function logTaskDebug(event: string, ctx: TaskLogCtx, details?: string): void {
  logDebug("task-pipeline", `${event}${formatCtx(ctx)}${details ? ` ${details}` : ""}`);
}

export function logTaskTrace(event: string, ctx: TaskLogCtx, details?: string): void {
  logTrace("task-pipeline", `${event}${formatCtx(ctx)}${details ? ` ${details}` : ""}`);
}

function formatCtx(ctx: TaskLogCtx): string {
  const formatted = fmtLogCtx(ctx);
  return formatted ? ` ${formatted}` : "";
}
import { logDebug, logTrace } from "../logger.js";
