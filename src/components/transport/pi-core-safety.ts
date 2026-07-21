import { logDebug, logWarn } from "../logger.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { ToolDecision, TurnDecision, PrepareNextTurnContext, AgentLoopTurnUpdate, AgentMessage } from "./pi-core-types.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";

const TAG = "pi-core-safety";

const MAX_PROMPT_ROUNDS = 25;
const MAX_CANDIDATE_ROUNDS = 10;

export type BehaviorIncidentType = "exact_repeat" | "repeated_failure" | "candidate_round_limit" | "prompt_round_limit";

export interface BehaviorIncident {
  type: BehaviorIncidentType;
  candidateKey: string;
  toolName?: string;
  roundsUsed: number;
}

export interface PiExecutionSafetyController {
  readonly promptRoundsUsed: number;
  readonly activeCandidateKey: string;
  beforeTool(name: string, args: Record<string, unknown>): ToolDecision;
  afterTool(name: string, result: string): ToolDecision;
  beginProviderTurn(candidateKey: string): TurnDecision;
  prepareNextTurn(context: PrepareNextTurnContext): AgentLoopTurnUpdate | undefined;
  requestPause(): void;
  requestStop(reason: string): void;
  recordClassifiedStoreLiteral(literal: string): void;
  scrubClassifiedLiterals(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }>;
  get incident(): BehaviorIncident | null;
  get paused(): boolean;
  get stopped(): boolean;
}

export function createPiExecutionSafetyController(
  policy: FallbackPolicy,
  options?: {
    maxPromptRounds?: number;
    maxCandidateRounds?: number;
  },
): PiExecutionSafetyController {
  let promptRounds = 0;
  let candidateRounds = 0;
  let activeCandidate = "";
  let batchCancelled = false;
  let _paused = false;
  let _stopped = false;
  let _stopReason = "";
  let _incident: BehaviorIncident | null = null;

  const classifiedLiterals: Set<string> = new Set();
  const loopGuard = new ToolLoopGuard();

  const mp = options?.maxPromptRounds ?? MAX_PROMPT_ROUNDS;
  const mc = options?.maxCandidateRounds ?? MAX_CANDIDATE_ROUNDS;

  return {
    get promptRoundsUsed() { return promptRounds; },
    get activeCandidateKey() { return activeCandidate; },
    get incident() { return _incident; },
    get paused() { return _paused; },
    get stopped() { return _stopped; },

    beforeTool(name: string, args: Record<string, unknown>): ToolDecision {
      if (batchCancelled) return { decision: "skip" };
      if (_paused || _stopped) return { decision: "skip" };

      const rawArgs = JSON.stringify(args);
      try {
        loopGuard.observeCall(name, rawArgs);
      } catch {
        logWarn(TAG, `Exact repeat detected: ${name}`);
        _incident = { type: "exact_repeat", candidateKey: activeCandidate, toolName: name, roundsUsed: promptRounds };
        batchCancelled = true;
        return { decision: "error", reason: `Exact repeat of ${name} — tool blocked` };
      }

      return { decision: "execute" };
    },

    afterTool(name: string, result: string): ToolDecision {
      if (batchCancelled) return { decision: "skip" };

      try {
        loopGuard.observeOutcome(name, result);
      } catch {
        logWarn(TAG, `Repeated failure detected: ${name}`);
        _incident = { type: "repeated_failure", candidateKey: activeCandidate, toolName: name, roundsUsed: promptRounds };
        batchCancelled = true;
        return { decision: "error", reason: `Repeated failure of ${name} — tool blocked` };
      }

      return { decision: "execute" };
    },

    beginProviderTurn(candidateKey: string): TurnDecision {
      if (_stopped) return { decision: "stop", reason: _stopReason };
      if (_paused) return { decision: "pause" };
      if (promptRounds >= mp) {
        _incident = { type: "prompt_round_limit", candidateKey, roundsUsed: promptRounds };
        return { decision: "stop", reason: `Prompt round limit (${mp}) reached` };
      }

      if (candidateKey !== activeCandidate) {
        candidateRounds = 0;
        activeCandidate = candidateKey;
      }

      if (candidateRounds >= mc) {
        // Candidate-round limit: exclude this candidate, don't stop execution.
        // The #1445 FallbackPolicy will select the next eligible candidate.
        _incident = { type: "candidate_round_limit", candidateKey, roundsUsed: candidateRounds };
        policy.excludedKeys.add(candidateKey);
        const [model, endpoint] = candidateKey.split("@");
        if (model && endpoint) policy.registry.recordError(model, endpoint, "weak");
        return { decision: "stop", reason: `Candidate round limit (${mc}) for ${candidateKey}` };
      }

      promptRounds++;
      candidateRounds++;
      batchCancelled = false;
      return { decision: "continue" };
    },

    prepareNextTurn(context: PrepareNextTurnContext): AgentLoopTurnUpdate | undefined {
      if (_paused || _stopped || promptRounds >= mp) {
        return undefined;
      }

      // Default: no incident → allow next turn unchanged
      if (!_incident) {
        return {
          model: { id: activeCandidate },
          context: undefined,
        };
      }

      const inc = _incident;
      _incident = null;
      let baseline: AgentMessage[] | undefined;

      // If context projection provides a safe baseline, use it to roll back
      // the failed tool exchange. This replaces the agent messages with the
      // last clean state before the incident happened.
      const ctx = context as { context?: unknown };
      const projectionCtx = ctx.context as { messages?: AgentMessage[] } | undefined;
      if (projectionCtx?.messages) {
        baseline = projectionCtx.messages;
      }

      if (inc.type === "exact_repeat" || inc.type === "repeated_failure") {
        const candidate = context.candidateKey;
        const [model, endpoint] = candidate.split("@");
        if (model && endpoint) {
          policy.excludedKeys.add(candidate);
          policy.registry.recordError(model, endpoint, "weak");
          logDebug(TAG, `Excluded candidate ${candidate} after ${inc.type}`);
        }
      }

      // Try next eligible candidate
      const next = policy.selectModel();
      if (!next) return undefined;

      logDebug(TAG, `prepareNextTurn: switching to ${next.model} via ${next.provider}`);

      // Return clean baseline context if available
      return {
        model: { id: next.model, provider: next.provider, endpoint: next.endpoint, maxContext: next.maxContext },
        context: baseline ? { messages: baseline } : undefined,
      };
    },

    requestPause(): void {
      _paused = true;
      logDebug(TAG, "Safety controller paused");
    },

    requestStop(reason: string): void {
      _stopped = true;
      _stopReason = reason;
      logDebug(TAG, `Safety controller stopped: ${reason}`);
    },

    recordClassifiedStoreLiteral(literal: string): void {
      if (literal.length > 4) classifiedLiterals.add(literal);
    },

    scrubClassifiedLiterals(
      messages: Array<{ role: string; content: string }>,
    ): Array<{ role: string; content: string }> {
      if (classifiedLiterals.size === 0) return messages;
      const result = messages.map((m) => {
        let { content } = m;
        for (const literal of classifiedLiterals) {
          content = content.split(literal).join("[REDACTED]");
        }
        return { ...m, content };
      });
      classifiedLiterals.clear();
      return result;
    },
  };
}
