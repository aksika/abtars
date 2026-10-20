import type { ModelCandidate } from "./transport/model-candidates.js";
import { resolveCandidateAuth } from "./transport/model-candidates.js";
import { getEnv } from "./env-schema.js";
/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";
import { resolveAgent, loadTransport, getEnvFallback } from "./transport-config.js";
import { logInfo, logWarn } from "./logger.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

export type AgentRole = "main" | "professor" | "dreamy" | "browsie" | "coding" | "cody" | "task";

export interface AgentRoleConfig {
  agent: string | null;
  model: string | null;
  autoReinit: boolean;
  tag: string;
  trust: number;
}

const AGENT_ROLES: Record<string, AgentRoleConfig> = {
  main: { agent: "professor", model: null, autoReinit: true, tag: "acp-main", trust: 3 },
  professor: { agent: "professor", model: null, autoReinit: true, tag: "acp-main", trust: 3 },
  dreamy: { agent: "dreamy", model: null, autoReinit: false, tag: "acp-sleep", trust: 2 },
  coding: { agent: "coding-agent", model: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  cody: { agent: "coding-agent", model: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  browsie: { agent: "browsie", model: null, autoReinit: false, tag: "acp-browsie", trust: 1 },
  task: { agent: "professor", model: null, autoReinit: false, tag: "acp-task", trust: 2 },
};

function resolveModel(role: string): string | undefined {
  switch (role) {
    case "browsie": return getEnv().browsingAgent;
    case "coding": case "cody": return getEnv().codingModel;
    default: return undefined;
  }
}

export interface TransportConfig {
  cliPath: string;
  workingDir: string;
  agentCli?: string;
  model?: string;
}

export function createAgentTransport(
  role: AgentRole,
  tc: TransportConfig,
  overrides?: Partial<AgentRoleConfig>,
): AcpTransport {
  const cfg = { ...AGENT_ROLES[role], ...overrides };
  const cliArgs = tc.agentCli === "gemini" ? ["--acp", "-y"] : undefined;
  const model = tc.model ?? resolveModel(role);

  return new AcpTransport(tc.cliPath, tc.workingDir, {
    agent: cfg.agent ?? undefined,
    model,
    autoReinit: cfg.autoReinit,
    tag: cfg.tag,
    cliArgs,
  });
}

export type SubagentRole = "sleep" | "browse" | "coding" | "task";

const SUBAGENT_TO_AGENT: Record<SubagentRole, string> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "cody",
  task: "main",
};

const SUBAGENT_ACP_ROLE: Record<SubagentRole, AgentRole> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  task: "task",
};

/** Runtime agent name -> transport-construction role (the inverse of the
 *  mapping createSubagentTransport applies). */
const AGENT_TO_SUBAGENT_ROLE: Record<import("./subagent-runtime.js").AgentName, SubagentRole> = {
  professor: "task",
  dreamy: "sleep",
  browsie: "browse",
  coding: "coding",
  task: "task",
};

/**
 * #1940: does this agent resolve to the Pi route? Spin needs the answer
 * BEFORE a one-shot transport exists (the SOUL decorator must not duplicate
 * a bundle the transport will install as its session system prompt). This
 * mirrors createSubagentTransport's resolution exactly — same role mapping,
 * same configured-agent fallback — so route decisions cannot drift.
 */
export function subagentAgentUsesPiTransport(
  agent: import("./subagent-runtime.js").AgentName,
): boolean {
  try {
    const tc = loadTransport();
    const agentName = SUBAGENT_TO_AGENT[AGENT_TO_SUBAGENT_ROLE[agent]];
    const resolved = (tc ? resolveAgent(agentName, tc) : null) ?? (tc ? resolveAgent("main", tc) : null);
    if (resolved) return resolved.provider.transport === "api";
    return getEnvFallback().provider.transport === "api";
  } catch {
    // Unreadable/invalid config cannot build a Pi transport either; the
    // decorator keeps its ACP default and transport construction reports the
    // real configuration failure.
    return false;
  }
}

/** Unified transport factory for all subagents. Reads from transport.json + models.json. */
/** @internal Used only by SubagentRuntime. Do not call directly. */
export async function createSubagentTransport(role: SubagentRole, memoryToolDeps?: import("./memory-store-quota.js").MemoryToolDependenciesHolder, candidatePolicy: import("./spin-types.js").CandidatePolicy = "fallback-chain", workingDir?: string): Promise<{ transport: IKiroTransport; model: string }> {
  const tc = loadTransport();
  const agentName = SUBAGENT_TO_AGENT[role];
  const resolved = tc ? resolveAgent(agentName, tc) : null;

  // Fallback: use main's config. If that also fails, use .env defaults.
  const mainResolved = resolved ?? (tc ? resolveAgent("main", tc) : null);
  const agent = mainResolved ?? (() => {
    const fb = getEnvFallback();
    return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
  })();

  if (agent.provider.transport === "api") {
    const { PiCoreTransport } = await import("./transport/pi-core-transport.js");
    const apiKey = getEnv().getApiKey(agent.provider.apiKeyEnv ?? "API_KEY");
    // #1757: Pi-managed mode rides the candidate; no key is resolved here.
    const primaryAuth = resolveCandidateAuth(agent.provider, (name) => getEnv().getApiKey(name), apiKey);

    const primaryEndpoint = agent.provider.endpoint ?? "http://localhost:11434/v1";

    // #1932: exactly one candidate per transport — the role's configured
    // model. No Main inheritance, no route fallbacks, no rotation.
    const candidate: ModelCandidate = {
      model: agent.model, provider: agent.providerName, endpoint: primaryEndpoint,
      apiKey: primaryAuth.apiKey, authSource: primaryAuth.authSource, maxContext: agent.contextWindow, apiFormat: agent.provider.apiFormat,
      // #1770: thread the resolved ceiling (pi catalog wins, models.json floor).
      maxOutput: agent.maxOutput,
      thinking: agent.provider.thinking,
      cacheRetention: agent.provider.cacheRetention ?? "short", source: "primary",
    };

    const transport = new PiCoreTransport({
      role: "specialist",
      systemPrompt: `You are an abtars ${agentName} agent.`,
      candidate,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      maxPromptRounds: tc?.maxToolRounds,
      // #1552: late-bound memory-tool deps holder from boot composition.
      memoryToolDeps: memoryToolDeps ?? { current: null },
    });
    await transport.initialize();
    logInfo("subagent", `${role} transport: PiCore ${agent.providerName} (model=${agent.model})`);
    return { transport, model: agent.model };
  }

  // ACP path — try configured model, then route-local fallbacks on failure.
  // #1611: configured-only attempts exactly the configured model during
  // initialization — no fallback models, no silent substitution.
  const { loadAndValidateConfig } = await import("./config.js");
  const config = await loadAndValidateConfig();
  const ra = tc ? (await import("./transport-config.js")).routeAssignments(tc) : null;
  const fallbackModels = candidatePolicy === "configured-only"
    ? []
    : (ra?.fallbacks ?? []).map(f => f.model).filter(m => m !== agent.model);
  const modelsToTry = [agent.model, ...fallbackModels];

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i]!;
    const transport = createAgentTransport(SUBAGENT_ACP_ROLE[role], {
      cliPath: agent.provider.cli ?? config.transport.agentCliPath,
      // #1807: an explicit sleep scope overrides the configured working dir
      // so CLI session creation honors the same root as tool execution.
      workingDir: workingDir ?? config.transport.workingDir,
      agentCli: agent.provider.cli ?? "kiro-cli",
      model,
    });
    try {
      await transport.initialize();
      if (i > 0) logWarn("subagent", `${role}: configured model failed, fell back to ${model}`);
      logInfo("subagent", `${role} transport: ACP ${agent.providerName} (model=${model}${i > 0 ? ", fallback" : ""})`);
      return { transport, model };
    } catch (err) {
      if (i < modelsToTry.length - 1) {
        logWarn("subagent", `${role}: model ${model} init failed (${err instanceof Error ? err.message : String(err)}), trying ${modelsToTry[i + 1]}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${role}: all models exhausted (tried ${modelsToTry.join(", ")})`);
}
