import type { ExecutionRoute } from "../transport-config.js";
import type { IKiroTransport, RuntimeStatusSnapshot } from "./kiro-transport.js";

export interface ConfiguredRuntimeFallback {
  route?: ExecutionRoute;
  provider?: string;
  model?: string;
}

export function resolveRuntimeStatus(
  transport: Pick<IKiroTransport, "getRuntimeStatus"> | null | undefined,
  configured: ConfiguredRuntimeFallback,
): RuntimeStatusSnapshot {
  const live = transport?.getRuntimeStatus?.();
  const result: RuntimeStatusSnapshot = {};
  if (live?.route !== undefined) result.route = live.route;
  else if (configured.route !== undefined) result.route = configured.route;
  if (live?.provider !== undefined) result.provider = live.provider;
  else if (configured.provider !== undefined) result.provider = configured.provider;
  if (live?.model !== undefined) result.model = live.model;
  else if (configured.model !== undefined) result.model = configured.model;
  if (live?.contextPercent !== undefined) result.contextPercent = live.contextPercent;
  if (live?.contextWindow !== undefined) result.contextWindow = live.contextWindow;
  if (live?.autoCompaction !== undefined) result.autoCompaction = live.autoCompaction;
  if (live?.reasoning !== undefined) result.reasoning = live.reasoning;
  if (live?.lastTurnUsage !== undefined) result.lastTurnUsage = live.lastTurnUsage;
  return result;
}

export function formatRuntimeRoute(status: RuntimeStatusSnapshot): string {
  if (status.route === "pi-ai") return `pi-ai API / ${status.provider ?? "unknown"}`;
  if (status.route === "acp") return "ACP";
  return "Unknown route";
}
