import { createHash } from "node:crypto";

export type ToolBehaviorReason =
  | "exact_repeat"
  | "repeated_failure"
  | "candidate_round_limit"
  | "prompt_round_limit";

export class ToolBehaviorError extends Error {
  readonly reason: ToolBehaviorReason;
  readonly toolName?: string;
  readonly roundsUsed: number;

  constructor(reason: ToolBehaviorReason, roundsUsed: number, toolName?: string) {
    const msg = reason === "exact_repeat"
      ? `Tool loop: ${toolName} repeated 3x with identical arguments`
      : reason === "repeated_failure"
        ? `Tool loop: ${toolName} failed 3x consecutively`
        : reason === "candidate_round_limit"
          ? `Candidate round limit reached (${roundsUsed})`
          : `Prompt round limit reached (${roundsUsed})`;
    super(msg);
    this.reason = reason;
    this.toolName = toolName;
    this.roundsUsed = roundsUsed;
    this.name = "ToolBehaviorError";
  }
}

interface CallFingerprint {
  name: string;
  hash: string;
}

interface FailureFingerprint {
  tool: string;
  outcomeFingerprint: string;
}

export class ToolLoopGuard {
  private lastCall: CallFingerprint | null = null;
  private consecutiveExactCalls = 0;
  private lastFailure: FailureFingerprint | null = null;
  private consecutiveEquivalentFailures = 0;
  private hadProgressSinceIncident = false;
  private _incidentAtRound = 0;
  private _roundsUsed = 0;

  observeCall(name: string, rawArguments: string): void {
    this._roundsUsed++;
    const hash = createHash("sha256").update(rawArguments).digest("hex").slice(0, 8);
    const fp: CallFingerprint = { name, hash };

    if (this.lastCall && this.lastCall.name === name && this.lastCall.hash === hash && !this.hadProgressSinceIncident) {
      this.consecutiveExactCalls++;
    } else {
      this.consecutiveExactCalls = 1;
    }

    this.lastCall = fp;
    this.hadProgressSinceIncident = false;

    if (this.consecutiveExactCalls >= 3) {
      this._incidentAtRound = this._roundsUsed;
      throw new ToolBehaviorError("exact_repeat", this._roundsUsed, name);
    }
  }

  observeOutcome(name: string, result: string): ToolOutcome {
    const outcome = classifyOutcome(result);
    const outcomeFp = deriveOutcomeFingerprint(result);

    if (outcome === "failure") {
      if (this.lastFailure
        && this.lastFailure.tool === name
        && this.lastFailure.outcomeFingerprint === outcomeFp
        && !this.hadProgressSinceIncident) {
        this.consecutiveEquivalentFailures++;
      } else {
        this.consecutiveEquivalentFailures = 1;
      }
      this.lastFailure = { tool: name, outcomeFingerprint: outcomeFp };

      if (this.consecutiveEquivalentFailures >= 3) {
        this._incidentAtRound = this._roundsUsed;
        throw new ToolBehaviorError("repeated_failure", this._roundsUsed, name);
      }
    } else {
      this.consecutiveEquivalentFailures = 0;
      this.hadProgressSinceIncident = true;
    }
    return outcome;
  }

  get roundsUsed(): number {
    return this._roundsUsed;
  }

  get incidentAtRound(): number {
    return this._incidentAtRound;
  }

  resetIncidentState(): void {
    this._incidentAtRound = 0;
    this.hadProgressSinceIncident = false;
  }
}

function deriveOutcomeFingerprint(result: string): string {
  try {
    const parsed = JSON.parse(result);
    const parts: string[] = [];
    if (parsed.exit_code != null) parts.push(`exit:${parsed.exit_code}`);
    if (parsed.signal != null) parts.push(`sig:${parsed.signal}`);
    if (parsed.error != null) {
      const errStr = typeof parsed.error === "string" ? parsed.error : String(parsed.error);
      parts.push(`err:${errStr.slice(0, 80)}`);
    }
    return parts.join("|") || "unknown";
  } catch {
    return "success";
  }
}

export type ToolOutcome = "success" | "failure";

export function classifyOutcome(result: string): ToolOutcome {
  try {
    const parsed = JSON.parse(result);
    if (parsed.error != null) return "failure";
    if (parsed.exit_code != null && parsed.exit_code !== 0) return "failure";
    if (parsed.success != null && parsed.success === false) return "failure";
  } catch {
    /* opaque/non-JSON output is success */
  }
  return "success";
}
