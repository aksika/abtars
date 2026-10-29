import { logDebug, logWarn } from "../logger.js";
import type { AbtarsAgentMessage } from "./pi-core-types.js";
import type { ToolDecision, TurnDecision } from "./pi-port.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";

const TAG = "pi-core-safety";

const MAX_PROMPT_ROUNDS = 25;

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

export type BehaviorIncidentType = "exact_repeat" | "repeated_failure" | "prompt_round_limit";

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
  requestPause(): void;
  requestStop(reason: string): void;
  recordClassifiedStoreLiteral(literal: string): void;
  scrubClassifiedLiterals(messages: AbtarsAgentMessage[]): AbtarsAgentMessage[];
  get incident(): BehaviorIncident | null;
  get lastTerminalIncident(): BehaviorIncident | null;
  get paused(): boolean;
  get stopped(): boolean;
  /** True only when a safety policy has actually terminated the execution. */
  get terminalSafetyFailure(): boolean;
}

/**
 * #1932: hard execution bounds without provider recovery. The controller
 * enforces the prompt-wide round limit and terminates on tool-loop
 * incidents (exact repeat, repeated failure) — it never rotates candidates,
 * admits corrective turns, or switches models. Provider availability is
 * the memo's job (admission) and Pi's job (in-conversation retries);
 * overflow is a terminal stream failure, not a safety incident.
 */
export function createPiExecutionSafetyController(
  options?: {
    maxPromptRounds?: number;
  },
): PiExecutionSafetyController {
  let promptRounds = 0;
  let activeCandidate = "";
  let batchCancelled = false;
  let _paused = false;
  let _stopped = false;
  let _stopReason = "";
  let _incident: BehaviorIncident | null = null;
  let _lastTerminalIncident: BehaviorIncident | null = null;
  let _terminalSafetyFailure = false;

  const classifiedLiterals: Set<string> = new Set();
  const loopGuard = new ToolLoopGuard();

  const mp = options?.maxPromptRounds ?? MAX_PROMPT_ROUNDS;

  function terminate(incident: BehaviorIncident): void {
    _incident = incident;
    _lastTerminalIncident = incident;
    _terminalSafetyFailure = true;
    batchCancelled = true;
  }

  return {
    get promptRoundsUsed() { return promptRounds; },
    get maxPromptRounds() { return mp; },
    get activeCandidateKey() { return activeCandidate; },
    get incident() { return _incident; },
    get lastTerminalIncident() { return _lastTerminalIncident; },
    get paused() { return _paused; },
    get stopped() { return _stopped; },
    get terminalSafetyFailure() { return _terminalSafetyFailure; },

    beforeTool(name: string, args: Record<string, unknown>): ToolDecision {
      if (batchCancelled) return { decision: "skip" };
      if (_paused || _stopped) return { decision: "skip" };

      const rawArgs = JSON.stringify(args);
      try {
        loopGuard.observeCall(name, rawArgs);
      } catch {
        logWarn(TAG, `Exact repeat detected: ${name}`);
        terminate({ type: "exact_repeat", candidateKey: activeCandidate, toolName: name, roundsUsed: promptRounds });
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
        terminate({ type: "repeated_failure", candidateKey: activeCandidate, toolName: name, roundsUsed: promptRounds });
        return { decision: "error", reason: `Repeated failure of ${name} — tool blocked` };
      }

      return { decision: "execute" };
    },

    beginProviderTurn(candidateKey: string): TurnDecision {
      if (_stopped) return { decision: "stop", reason: _stopReason };
      if (_paused) return { decision: "pause" };

      if (promptRounds >= mp) {
        const incident: BehaviorIncident = { type: "prompt_round_limit", candidateKey, roundsUsed: promptRounds };
        terminate(incident);
        return { decision: "stop", reason: `Prompt round limit (${mp}) reached` };
      }

      // Attribution only: the single configured candidate owns every turn,
      // so there is no rotation segment to track or reset.
      activeCandidate = candidateKey;
      promptRounds++;
      batchCancelled = false;
      return { decision: "continue" };
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
