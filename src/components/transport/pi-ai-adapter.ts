/**
 * pi-ai adapter — candidate → Pi model shape and Pi's thinking-level clamp.
 *
 * #1940: Pi's AgentSession makes every provider call; this module only maps
 * the abtars API format to Pi's API family and resolves the effective
 * reasoning level with Pi's own clamp (for status and /effort).
 *
 * Contracts verified against @earendil-works/pi-ai@~1.3.0 via devDependency.
 */

import type { Api, ThinkingLevel, ModelThinkingLevel, Model } from "@earendil-works/pi-ai";

// #1746: Pi's authoritative thinking-level clamp, captured from the runtime
// pi-ai root module. It is held in a module slot because resolveCandidateModel()
// is synchronous and is called from PiCoreTransport's constructor and from
// setReasoningEffort() — neither may become async (#1619 clamps at construction
// so /status cannot claim xhigh before the first turn). Populated by
// ensurePiThinkingClamp(); unset means "pi not loaded yet", never "no clamp
// needed". No @earendil-works implementation may enter the bundle through a
// static import — the pi installation is the only source of this function
// (enforced by scripts/check-pi-boundary.mjs and scripts/check-bundle-boundary.mjs).
let piThinkingClamp: ((model: Model<Api>, level: ModelThinkingLevel) => ModelThinkingLevel) | null = null;

/** #1746: log the unpopulated-clamp pass-through at most once per process. */
let clampMissLogged = false;

/**
 * #1746: load the pi-ai root module once and capture `clampThinkingLevel`.
 * Idempotent and safe to call from several boot paths. Accepts a pi-ai root
 * module the caller has already loaded (the runtime-contract probe) and
 * otherwise resolves it through the standard installation-scoped loader. No
 * new module specifier: the pi-ai root is what defaultLoadPi/defaultLoadApi
 * resolve today. Resolves without populating the slot when the installation
 * is absent or unloadable — the api route fails its runtime contract on the
 * first prompt in that case, so a boot-time throw would only move the same
 * failure earlier and less informatively. Never throws to its caller.
 */
export async function ensurePiThinkingClamp(piAiRoot?: Record<string, unknown>): Promise<void> {
  if (piThinkingClamp) return;
  let root = piAiRoot;
  if (!root) {
    try {
      const result = resolvePiInstallation();
      if (result.state !== "compatible") return;
      const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai" };
      root = await loadPiModule<Record<string, unknown>>(result.installation, aiSpec);
    } catch {
      // absent or unloadable installation — degrade, never throw
      return;
    }
  }
  const clamp = root.clampThinkingLevel;
  if (typeof clamp === "function") {
    piThinkingClamp = clamp as (model: Model<Api>, level: ModelThinkingLevel) => ModelThinkingLevel;
  }
}

import { logDebug } from "../logger.js";
import { resolveModelMeta } from "./pi-catalog.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier } from "../pi-installation.js";
import type { ReasoningEffort } from "./kiro-transport.js";

export type LegacyToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const TAG = "pi-ai-adapter";

// ─── abtars-side input types ────────────────────────────────────────────────

export type ApiFormat = "chat" | "responses" | "anthropic";

/** The active candidate L2 selected — exactly what L0 would call with. */
export interface PiAiCandidate {
  model: string;
  endpoint: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  maxOutput: number;
  /** Model's context window in tokens. #1326: propagated from DirectApiConfig
   *  so `buildPiModel` carries a real value and pi-ai's own
   *  `clampMaxTokensToContext` guard becomes functional as a second layer. */
  contextWindow?: number;
  // #1311 + #1276: thinking config — three styles.
  //   "default"  → use the model's own default reasoning level (no override, no force).
  //                pi-ai doesn't get a `reasoning` option → no `reasoning_effort` in body
  //                for openrouter/chat-completions → model uses its own default.
  //   "effort"   → force a specific effort level (pi-ai's level set, off|low|medium|high|xhigh).
  //   "extended" → Anthropic extended-budget style; `default` is the budget_tokens value.
  //                Reasoning is enabled but no level is passed to pi-ai for openrouter.
  thinking?:
    | { style: "default" }
    | { style: "effort"; default: "off" | "low" | "medium" | "high" | "xhigh" }
    | { style: "extended"; default: number };
  /** Session-level reasoning override (from /effort or /thinking command). */
  reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | null;
}

// ─── pure translators ───────────────────────────────────────────────────────

/** Map abtars apiFormat → pi Api family. chat/undefined → openai-completions. */
export function pickPiApi(apiFormat?: ApiFormat): Api {
  if (apiFormat === "responses") return "openai-responses";
  if (apiFormat === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

// #1276: align with pi-ai's effort level vocabulary. pi-ai's ThinkingLevel is
// "minimal" | "low" | "medium" | "high" | "xhigh" | "max" (ModelThinkingLevel adds
// "off"). abtars exposes a deliberate subset — the /effort + /thinking commands and
// DirectApiConfig only speak off|low|medium|high|xhigh — so the validation set
// below mirrors that abtars subset, not pi-ai's full range. (Adding "minimal"/"max"
// would be a config-surface change, out of scope for the #1425 boundary review.)
const EFFORT_LEVELS: readonly string[] = ["off", "low", "medium", "high", "xhigh"];

function mapEffortLevel(s: string | undefined): ModelThinkingLevel | undefined {
  if (!s) return undefined;
  return EFFORT_LEVELS.includes(s) ? (s as ModelThinkingLevel) : "medium";
}

/**
 * Resolve the reasoning level to pass to pi, given abtars config.
 *
 * Phase 1 parity note: abtars's DirectApi path only emits reasoning params on the
 * completions branch today (responses/anthropic adapters take no thinking arg).
 * We mirror that — reasoning is enabled only when an effort level is available
 * (session override or effort-style thinking config). Extended-budget style and
 * the responses/anthropic paths defer reasoning to the bake (later task).
 *
 * "off" levels are filtered here — pi's SimpleStreamOptions.reasoning uses
 * ThinkingLevel (which excludes "off"); to disable reasoning, omit the option.
 */
export function resolveReasoning(candidate: PiAiCandidate): { reasoning: boolean; level: ThinkingLevel | undefined } {
  if (candidate.thinking?.style === "default") return { reasoning: true, level: undefined };
  const rawLevel: ModelThinkingLevel | undefined | null = candidate.reasoningEffort
    ?? (candidate.thinking?.style === "effort" ? mapEffortLevel(candidate.thinking.default) : undefined);
  if (!rawLevel || rawLevel === "off") return { reasoning: false, level: undefined };
  return { reasoning: true, level: rawLevel };
}

/**
 * Construct a single pi Model FROM the abtars candidate (not from pi's catalog).
 * #1326: contextWindow is now sourced from `candidate.contextWindow` (the L0
 * caller has already clamped maxOutput against it) — this enables pi-ai's own
 * `clampMaxTokensToContext` client-side guard as a belt-and-suspenders second
 * layer. `?? 0` preserves the prior behavior for legacy test fixtures that
 * don't set the field (pi-ai's guard no-ops when contextWindow <= 0, matching
 * its own convention for "unknown" windows).
 */
export function buildPiModel(candidate: PiAiCandidate, api: Api, hasImage: boolean, providerId: string): Model<Api> {
  const { reasoning } = resolveReasoning(candidate);
  return {
    id: candidate.model,
    name: candidate.model,
    api,
    provider: providerId,
    baseUrl: candidate.endpoint,
    reasoning,
    input: hasImage ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: candidate.contextWindow ?? 0,
    maxTokens: candidate.maxOutput,
  };
}

/** #1619: a candidate model plus its requested and Pi-clamped effective levels. */
export interface ResolvedPiModel {
  model: Model<Api>;
  requested: ReasoningEffort;
  effective: ReasoningEffort;
}

/**
 * #1619: resolve a candidate's model with a session-scoped requested effort
 * threaded through, then clamp the request against Pi's authoritative model
 * capability semantics (`clampThinkingLevel`). An effective "off" forces
 * `model.reasoning` false so no reasoning param is emitted. A custom Pi model
 * without a non-null `thinkingLevelMap.xhigh` never claims xhigh — Pi's
 * clamped result wins.
 *
 * #1770: maxOutput is never invented here. The threaded candidate value
 * (resolved at construction: pi catalog wins, models.json floor) leads; a
 * live pi-catalog lookup covers ad-hoc candidates built without resolution;
 * the models.json-miss default (8192, mirroring transport-config/resolver)
 * is the last resort. A hardcoded small cap starves thinking models —
 * reasoning and answer share max_tokens, so the cap burns on thinking and
 * the turn settles length-truncated with empty content.
 */
export function resolveCandidateModel(
  candidate: {
    model: string;
    endpoint: string;
    apiKey?: string;
    apiFormat?: ApiFormat;
    thinking?: PiAiCandidate["thinking"];
    maxContext: number;
    maxOutput?: number;
    provider: string;
  },
  requestedEffort: ReasoningEffort,
  hasImage: boolean,
): ResolvedPiModel {
  const maxOutput = candidate.maxOutput
    ?? resolveModelMeta(candidate.model, candidate.provider)?.maxOutput
    ?? 8192;
  const piCandidate: PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    apiFormat: candidate.apiFormat,
    thinking: candidate.thinking,
    reasoningEffort: requestedEffort,
    maxOutput,
    contextWindow: candidate.maxContext,
  };
  const model = buildPiModel(piCandidate, pickPiApi(candidate.apiFormat), hasImage, candidate.provider);
  const clamped = piThinkingClamp ? piThinkingClamp(model, requestedEffort) : requestedEffort;
  const effective = clamped === "minimal" || clamped === "max" ? ("high" as ReasoningEffort) : (clamped as ReasoningEffort);
  if (effective === "off") model.reasoning = false;
  if (!piThinkingClamp && !clampMissLogged) {
    clampMissLogged = true;
    logDebug(TAG, "#1746: thinking clamp not populated — passing requested effort through (pi not loaded yet)");
  }
  return { model, requested: requestedEffort, effective };
}
