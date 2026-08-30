/**
 * transport-config/types.ts — public type surface for transport configuration.
 * Type declarations only; no runtime state, filesystem, or environment access.
 */

import type { HealthPolicyConfig } from "../transport/model-health-registry.js";

export type ModelCost = {
  /** $/token — accurate, used for arithmetic (sort, usage accounting, pi-catalog copy). */
  input: number;
  /** $/token — accurate, used for arithmetic. */
  output: number;
  /** Picker-facing, derived from input/output at load time. Never written to models.json. */
  display?: { inputPer1M: string; outputPer1M: string };
};

export type ModelEntry = {
  contextWindow: number;
  maxOutput: number;
  rank: number;
  cost: ModelCost;
  transports: string[];
  description?: string;
  addedAt?: string;
  validatedAt?: string;
  status?: "alive" | "dead" | "untested";
};

export type ModelCatalog = Record<string, ModelEntry>;

export type ExecutionRoute = "pi-ai" | "acp";

export type AgentAssignment = {
  model: string;
  provider: string;
};

export type ProviderConfig = {
  transport: "acp" | "tmux" | "api";
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  apiFormat?: "chat" | "responses" | "anthropic";
  thinking?:
    | { style: "default" }
    | { style: "effort"; default: "off" | "low" | "medium" | "high" | "xhigh" }
    | { style: "extended"; default: number };
  /** #1748: prompt-cache retention preference. Absent → "short" (pi's
   *  default, pinned explicitly by the transport). "long" is opt-in per
   *  provider: Anthropic bills 1h cache writes at 2x base input, so it is
   *  never a global default. */
  cacheRetention?: "none" | "short" | "long";
  defaults?: Record<string, { model: string }>;
};

export type TransportDefaults = {
  tmux?: { session?: string; captureDelaySec?: number; maxWaitSec?: number };
  acp?: { permissionTimeoutMs?: number };
};

export type RouteAssignments = {
  agents: Record<string, AgentAssignment>;
  fallbacks?: Array<{ model: string; provider: string }>;
};

export type HailMaryConfig = {
  route: "acp";
  model: string;
  provider: string;
};

export type ResolvedHailMary = HailMaryConfig & {
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
};

export type TransportConfig = {
  schemaVersion: 3;
  activeRoute: ExecutionRoute;
  routes: Partial<Record<ExecutionRoute, RouteAssignments>>;
  providers: Record<string, ProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
  maxToolRounds?: number;
  /** #1386: Lower tool-round limit for fallback candidates. Default 5. */
  maxFallbackToolRounds?: number;
  hailMary?: HailMaryConfig;
  healthPolicy?: HealthPolicyConfig;
};

export type ResolvedAgent = {
  model: string;
  provider: ProviderConfig;
  providerName: string;
  contextWindow: number;
  maxOutput: number;
  fallbacks: Array<{ model: string; provider: string }>;
};

export type TransportConfigIssueCode =
  | "unsupported_schema"
  | "missing_field"
  | "invalid_route"
  | "missing_provider"
  | "model_provider_incompatible"
  | "provider_route_incompatible"
  | "acp_provider_mismatch"
  | "plaintext_secret_field"
  | "invalid_provider_field"
  | "invalid_config_field";

export interface TransportConfigIssue {
  code: TransportConfigIssueCode;
  path: string;
  message: string;
}

export type TransportValidationResult =
  | { ok: true; config: TransportConfig }
  | { ok: false; issues: readonly TransportConfigIssue[] };

export type TransportConfigSource = "primary" | "backup" | "default";

export type TransportLoadResult =
  | { ok: true; config: TransportConfig; source: TransportConfigSource }
  | { ok: false; issues: readonly TransportConfigIssue[]; state: "missing" | "invalid"; source?: TransportConfigSource };

export type EnvFallback = {
  provider: ProviderConfig;
  providerName: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
};

export type ModelProviderValidation =
  | { ok: true }
  | { ok: false; model: string; provider: string; allowed: string[]; reason: string };

export type AssignmentIssue = {
  location: string;
  model: string;
  provider: string;
  reason: string;
};

export type TransportWriteResult =
  | { ok: true }
  | { ok: false; issues: AssignmentIssue[] };

export type ProviderValidationResult =
  | { ok: true }
  | { ok: false; reason: string; fix: string };

/**
 * Minimal env accessor — just the slice validateProviderReady needs.
 * Matches the shape exposed by getEnv().
 */
export type EnvAccessor = {
  getApiKey(envName: string): string | undefined;
};