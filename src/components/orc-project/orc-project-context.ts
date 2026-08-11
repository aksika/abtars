import type { OrcInvocationContextV1, OrcRunReason } from "./orc-project-contracts.js";
import { OrcProjectRunStore } from "./orc-project-run-store.js";
import { formatRunReason } from "./orc-project-contracts.js";

export interface ToolContextResolution {
  ok: true;
  context: OrcInvocationContextV1;
  store: OrcProjectRunStore;
}

export interface ToolContextError {
  ok: false;
  code: OrcRunReason;
  message: string;
}

export type ToolContextResult = ToolContextResolution | ToolContextError;

export type PeerEgressResult =
  | { allowed: true }
  | { allowed: false; reason: "peer_relay_blocked" | OrcRunReason }

export function resolveCurrentOrcProject(
  args: Record<string, string>,
  toolContext: { orcContext?: OrcInvocationContextV1 },
  store?: OrcProjectRunStore,
): ToolContextResult {
  const ctx = toolContext.orcContext;
  if (!ctx) {
    const argProjectId = args.project_card_id ? Number(args.project_card_id) : undefined;
    if (argProjectId) {
      return { ok: false as const, code: "context_missing", message: "Orc invocation context is missing. Use run-bound tools within an active Orc turn." };
    }
    return { ok: false as const, code: "context_missing", message: "No active Orc project and no Orc invocation context." };
  }

  const s = store ?? new OrcProjectRunStore();
  const validation = s.validateCurrentContext(ctx);
  if (!validation.ok) {
    return { ok: false as const, code: validation.reason, message: formatRunReason(validation.reason) };
  }

  if (args.project_card_id) {
    const suppliedProjectId = Number(args.project_card_id);
    if (suppliedProjectId !== ctx.projectCardId) {
      return { ok: false as const, code: "project_mismatch", message: `Supplied project_card_id ${suppliedProjectId} does not match bound project ${ctx.projectCardId}` };
    }
  }

  return { ok: true, context: ctx, store: s };
}

export function authorizePeerEgress(
  toolContext: { orcContext?: OrcInvocationContextV1 },
  store?: OrcProjectRunStore,
): PeerEgressResult {
  const ctx = toolContext.orcContext;
  if (!ctx) {
    return { allowed: false as const, reason: "context_missing" };
  }

  const s = store ?? new OrcProjectRunStore();
  const validation = s.validateCurrentContext(ctx);
  if (!validation.ok) {
    return { allowed: false as const, reason: validation.reason };
  }

  if (ctx.origin.kind === "peer") {
    return { allowed: false as const, reason: "peer_relay_blocked" };
  }

  return { allowed: true };
}
