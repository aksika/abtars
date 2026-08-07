import { logDebug, logWarn, logTrace } from "../logger.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import { candidateKey as candidateIdentityKey } from "./model-candidates.js";
import type { AgentContext, AgentLoopTurnUpdate, AgentMessage, AbtarsAgentMessage, SafetyPrepareNextTurnContext, ModelApi, ToolDecision, TurnDecision } from "./pi-core-types.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";

const TAG = "pi-core-safety";

const MAX_PROMPT_ROUNDS = 25;
const MAX_CANDIDATE_ROUNDS = 10;

function redactValue(value: unknown, literals: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const literal of literals) result = result.split(literal).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, literals));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, literals)]),
    );
  }
  return value;
}

export type BehaviorIncidentType = "exact_repeat" | "repeated_failure" | "candidate_round_limit" | "prompt_round_limit";

export interface BehaviorIncident {
  type: BehaviorIncidentType;
  candidateKey: string;
  toolName?: string;
  roundsUsed: number;
}

export interface PiExecutionSafetyController {
  readonly promptRoundsUsed: number;
  readonly maxPromptRounds: number;
  readonly activeCandidateKey: string;
  beforeTool(name: string, args: Record<string, unknown>): ToolDecision;
  afterTool(name: string, result: string): ToolDecision;
  beginProviderTurn(candidateKey: string): TurnDecision;
  prepareNextTurn(context: SafetyPrepareNextTurnContext): AgentLoopTurnUpdate | undefined;
  requestPause(): void;
  requestStop(reason: string): void;
  recordClassifiedStoreLiteral(literal: string): void;
  scrubClassifiedLiterals(messages: AbtarsAgentMessage[]): AbtarsAgentMessage[];
  get incident(): BehaviorIncident | null;
  get lastTerminalIncident(): BehaviorIncident | null;
  get paused(): boolean;
  get stopped(): boolean;
  /** #1502: Whether a corrective turn has been admitted for the current incident. */
  get correctiveAdmitted(): boolean;
  /** True only when a safety policy has actually terminated the execution. */
  get terminalSafetyFailure(): boolean;
}

export function createPiExecutionSafetyController(
  policy: FallbackPolicy,
  options?: {
    maxPromptRounds?: number;
    maxCandidateRounds?: number;
    modelForCandidate?: (candidateKey: string) => ModelApi | undefined;
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
  let _lastTerminalIncident: BehaviorIncident | null = null;
  let _correctiveAdmitted = false;
  let _terminalSafetyFailure = false;

  const classifiedLiterals: Set<string> = new Set();
  const loopGuard = new ToolLoopGuard();

  const mp = options?.maxPromptRounds ?? MAX_PROMPT_ROUNDS;
  const mc = options?.maxCandidateRounds ?? MAX_CANDIDATE_ROUNDS;

  function buildCorrectiveInstruction(inc: BehaviorIncident): string {
    const tool = inc.toolName ?? "tool";
    const incident = inc.type === "exact_repeat" ? "exact repeat of the same action" : "repeated failure of the same action";
    return [
      "[SAFETY RECOVERY]",
      `The previous ${tool} action was blocked for ${incident}.`,
      "Do not repeat the same action. Choose different arguments or another strategy.",
      "[/SAFETY RECOVERY]",
    ].join("\n");
  }

  return {
    get promptRoundsUsed() { return promptRounds; },
    get maxPromptRounds() { return mp; },
    get activeCandidateKey() { return activeCandidate; },
    get incident() { return _incident; },
    get lastTerminalIncident() { return _lastTerminalIncident; },
    get paused() { return _paused; },
    get stopped() { return _stopped; },
    get correctiveAdmitted() { return _correctiveAdmitted; },
    get terminalSafetyFailure() { return _terminalSafetyFailure; },

    beforeTool(name: string, args: Record<string, unknown>): ToolDecision {
      if (batchCancelled) return { decision: "skip" };
      if (_paused || _stopped) return { decision: "skip" };

      const rawArgs = JSON.stringify(args);
      try {
        loopGuard.observeCall(name, rawArgs);
      } catch {
        logWarn(TAG, `Exact repeat detected: ${name}`);
        _incident = { type: "exact_repeat", candidateKey: activeCandidate, toolName: name, roundsUsed: promptRounds };
        if (_correctiveAdmitted) {
          _lastTerminalIncident = _incident;
          batchCancelled = true;
          _terminalSafetyFailure = true;
          return { decision: "error", reason: `Exact repeat of ${name} — tool blocked — already admitted corrective turn` };
        }
        _lastTerminalIncident = _incident;
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
        if (_correctiveAdmitted) {
          _lastTerminalIncident = _incident;
          batchCancelled = true;
          _terminalSafetyFailure = true;
          return { decision: "error", reason: `Repeated failure of ${name} — tool blocked — already admitted corrective turn` };
        }
        _lastTerminalIncident = _incident;
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
        _lastTerminalIncident = _incident;
        _terminalSafetyFailure = true;
        return { decision: "stop", reason: `Prompt round limit (${mp}) reached` };
      }

      if (candidateKey !== activeCandidate) {
        candidateRounds = 0;
        activeCandidate = candidateKey;
      }

      // #1595: a sole eligible candidate bypasses candidate-round rotation
      // entirely — no temporary exclusion, reselection, or repeated
      // "no alternate, continuing" logs. The prompt-wide limit is the only
      // bound it can hit, so keep advancing promptRounds below.
      if (policy.survivingCandidates().length <= 1) {
        promptRounds++;
        batchCancelled = false;
        return { decision: "continue" };
      }

      if (candidateRounds >= mc) {
        _incident = { type: "candidate_round_limit", candidateKey, roundsUsed: candidateRounds };
        _lastTerminalIncident = _incident;
        // Rotation exclusions are deliberately separate from behavior
        // exclusions. A successful candidate must not become permanently
        // unhealthy just because it completed one rotation segment.
        policy.rotationExcludedKeys.add(candidateKey);
        const next = policy.selectModel();
        if (next) {
          logDebug(TAG, `Candidate round limit for ${candidateKey} — switching to ${next.model}`);
          return { decision: "stop", reason: `Candidate round limit (${mc}) for ${candidateKey} — switching` };
        }
        // All eligible candidates completed this rotation segment. Start a
        // fresh rotation cycle; the current candidate is eligible again, but
        // provider-health and behavior exclusions remain intact.
        policy.rotationExcludedKeys.clear();
        const cycled = policy.selectModel();
        if (cycled && candidateIdentityKey(cycled.model, cycled.endpoint) !== candidateKey) {
          logDebug(TAG, `Candidate round limit for ${candidateKey} — cycling to ${cycled.model}`);
          return { decision: "stop", reason: `Candidate round limit (${mc}) for ${candidateKey} — cycling` };
        }
        // No eligible alternate exists. This is normally handled by the sole
        // candidate fast path above; retain the prompt-wide hard bound as the
        // final safety limit for a policy that becomes exhausted mid-turn.
        logDebug(TAG, `Candidate round limit for ${candidateKey} — no alternate, continuing`);
        promptRounds++;
        candidateRounds++;
        batchCancelled = false;
        return { decision: "continue" };
      }

      promptRounds++;
      candidateRounds++;
      batchCancelled = false;
      return { decision: "continue" };
    },

    prepareNextTurn(context: SafetyPrepareNextTurnContext): AgentLoopTurnUpdate | undefined {
      if (_paused || _stopped || promptRounds >= mp) {
        return undefined;
      }

      if (!_incident) return undefined;

      const inc = _incident;
      _incident = null;
      let baseline: AgentMessage[] | undefined;

      const projectionCtx = context.context as AgentContext | undefined;
      if (projectionCtx?.messages) baseline = projectionCtx.messages;

      if (inc.type === "exact_repeat" || inc.type === "repeated_failure") {
        const candidate = context.candidateKey;
        const [candidateModel, _candidateEndpoint] = candidate.split("@");
        if (candidateModel && _candidateEndpoint) {
          // Behavior recovery should be able to use any healthy candidate;
          // successful-turn rotation exclusions are not health exclusions.
          policy.rotationExcludedKeys.clear();
          if (!_correctiveAdmitted) {
            policy.excludedKeys.add(candidate);
          }
          logDebug(TAG, `Processing incident ${inc.type} for candidate ${candidate} (correctiveAdmitted=${_correctiveAdmitted})`);
          logTrace(TAG, `pi_behavior_incident type=${inc.type} candidate=${candidate} correctiveAdmitted=${_correctiveAdmitted}`);
        }

        const next = policy.selectModel();
        if (next) {
          logDebug(TAG, `prepareNextTurn: switching to ${next.model} via ${next.provider}`);
          logTrace(TAG, `pi_candidate_switched from=${candidate} to=${next.model} reason=${inc.type}`);
          const nextModel = context.modelForCandidate?.(`${next.model}@${next.endpoint}`);
          if (!nextModel) {
            logWarn(TAG, `Candidate ${next.model} selected without a public Pi model; ending turn`);
            return undefined;
          }
          _correctiveAdmitted = true;
          loopGuard.resetIncidentState();
          // #1502 (spec §5): append the corrective instruction to the clean
          // projected baseline so the alternate candidate sees why recovery
          // occurred. Without it, the new candidate inherits no feedback and may
          // repeat the blocked action.
          const switchCorrective = {
            role: "user",
            content: buildCorrectiveInstruction(inc),
            timestamp: Date.now(),
          } as AgentMessage;
          return {
            model: nextModel,
            context: projectionCtx && baseline
              ? { ...projectionCtx, messages: [...baseline, switchCorrective] }
              : undefined,
          };
        }

        if (_correctiveAdmitted) {
          logWarn(TAG, `Equivalent incident recurs after corrective admission — terminating`);
          logTrace(TAG, `pi_corrective_turn_terminal candidate=${candidate} type=${inc.type}`);
          _lastTerminalIncident = inc;
          _terminalSafetyFailure = true;
          return undefined;
        }

        policy.excludedKeys.delete(candidate);
        logDebug(TAG, `No alternate candidate for ${candidate} — retaining sole candidate with corrective turn`);
        logTrace(TAG, `pi_corrective_turn_admitted candidate=${candidate} type=${inc.type}`);

        const soleModel = context.modelForCandidate?.(candidate);
        if (!soleModel) {
          logWarn(TAG, `Sole candidate ${candidate} has no model — ending turn`);
          return undefined;
        }

        _correctiveAdmitted = true;
        loopGuard.resetIncidentState();

        const correctiveMsg = {
          role: "user",
          content: buildCorrectiveInstruction(inc),
          timestamp: Date.now(),
        } as AgentMessage;

        return {
          model: soleModel,
          context: projectionCtx && baseline
            ? { ...projectionCtx, messages: [...baseline, correctiveMsg] }
            : undefined,
        };
      }

      return undefined;
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
      messages: AbtarsAgentMessage[],
    ): AbtarsAgentMessage[] {
      if (classifiedLiterals.size === 0) return messages;
      const literals = [...classifiedLiterals];
      const result = messages.map((m) => {
        if (!("content" in m)) return m;
        return { ...m, content: redactValue(m.content, literals) } as AbtarsAgentMessage;
      });
      classifiedLiterals.clear();
      return result;
    },
  };
}
