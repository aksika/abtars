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

export class ToolLoopGuard {
  private readonly callSignatures: Array<{ name: string; hash: string }> = [];
  private readonly consecutiveFailures = new Map<string, number>();

  observeCall(name: string, rawArguments: string): void {
    const hash = createHash("sha256").update(rawArguments).digest("hex").slice(0, 8);
    this.callSignatures.push({ name, hash });
    const count = this.callSignatures.filter(s => s.name === name && s.hash === hash).length;
    if (count >= 3) {
      throw new ToolBehaviorError("exact_repeat", this.callSignatures.length, name);
    }
  }

  observeOutcome(name: string, result: string): ToolOutcome {
    const outcome = classifyOutcome(result);
    if (outcome === "failure") {
      const streak = (this.consecutiveFailures.get(name) ?? 0) + 1;
      this.consecutiveFailures.set(name, streak);
      if (streak >= 3) {
        throw new ToolBehaviorError("repeated_failure", this.callSignatures.length, name);
      }
    } else {
      this.consecutiveFailures.set(name, 0);
    }
    return outcome;
  }

  get roundsUsed(): number {
    return this.callSignatures.length;
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
