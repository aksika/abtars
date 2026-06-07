/**
 * transport-state.ts — ACP transport state machine (#188).
 *
 * States: idle | prompting | tool-active | reinitializing | stalled | destroyed
 * Invalid transitions throw TransportStateError (immediately visible in logs).
 */

export type TransportState = "idle" | "prompting" | "tool-active" | "reinitializing" | "stalled" | "destroyed";

export class TransportStateError extends Error {
  constructor(from: TransportState, to: TransportState, event: string) {
    super(`Invalid transport transition: ${from} → ${to} (event: ${event})`);
    this.name = "TransportStateError";
  }
}

const VALID_TRANSITIONS: Record<TransportState, TransportState[]> = {
  idle: ["prompting", "reinitializing", "destroyed"],
  prompting: ["idle", "tool-active", "reinitializing", "destroyed"],
  "tool-active": ["prompting", "idle", "reinitializing", "destroyed"],
  reinitializing: ["idle", "stalled", "destroyed"],
  stalled: ["idle", "destroyed"], // only manual /restart recovers
  destroyed: [], // terminal
};

export class TransportStateMachine {
  private _state: TransportState = "idle";
  private _reinitFailures = 0;
  private readonly _maxReinitFailures: number;
  private readonly _onTransition?: (from: TransportState, to: TransportState) => void;

  constructor(opts?: { maxReinitFailures?: number; onTransition?: (from: TransportState, to: TransportState) => void }) {
    this._maxReinitFailures = opts?.maxReinitFailures ?? 3;
    this._onTransition = opts?.onTransition;
  }

  get state(): TransportState { return this._state; }
  get isPromptable(): boolean { return this._state === "idle"; }
  get isActive(): boolean { return this._state === "prompting" || this._state === "tool-active"; }
  get isAlive(): boolean { return this._state !== "destroyed" && this._state !== "stalled"; }

  transition(to: TransportState, event: string): void {
    if (this._state === "destroyed" && to !== "destroyed") {
      // destroyed is terminal — ignore all transitions except redundant destroyed
      return;
    }
    if (!VALID_TRANSITIONS[this._state].includes(to)) {
      throw new TransportStateError(this._state, to, event);
    }
    const from = this._state;
    this._state = to;
    if (to === "idle") this._reinitFailures = 0;
    this._onTransition?.(from, to);
  }

  // ── Convenience transition methods ────────────────────────────────────────

  startPrompt(): void {
    this.transition("prompting", "startPrompt");
  }

  toolStarted(): void {
    this.transition("tool-active", "toolStarted");
  }

  toolCompleted(): void {
    this.transition("prompting", "toolCompleted");
  }

  promptCompleted(): void {
    if (this._state === "idle") return; // stale late completion — retry already reset state
    this.transition("idle", "promptCompleted");
  }

  childExited(): void {
    if (this._state === "destroyed") return; // intentional kill — no-op
    this.transition("reinitializing", "childExited");
  }

  reinitSucceeded(): void {
    this._reinitFailures = 0;
    this.transition("idle", "reinitSucceeded");
  }

  reinitFailed(): void {
    this._reinitFailures++;
    if (this._reinitFailures >= this._maxReinitFailures) {
      this.transition("stalled", "reinitFailed (max attempts)");
    }
    // stay in reinitializing for retry
  }

  destroy(): void {
    this.transition("destroyed", "destroy");
  }

  /** Manual recovery from stalled state (e.g. /restart command). */
  recover(): void {
    if (this._state !== "stalled") return;
    this._reinitFailures = 0;
    this.transition("idle", "recover");
  }
}
