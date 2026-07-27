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
