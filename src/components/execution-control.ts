import { logDebug } from "./logger.js";
import type { CancelReason } from "./swarm-executor-types.js";

export type WorkerTerminalOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export interface WorkerExecutionControl {
  readonly attemptId: string;
  readonly generation: number;
  readonly cardId: number;
  readonly cancelled: boolean;
  readonly cancelReason?: CancelReason;
  readonly terminal: boolean;
  readonly terminalOutcome?: WorkerTerminalOutcome;

  bind(cancel: (reason: CancelReason) => Promise<void> | void): boolean;
  requestCancel(reason: CancelReason): Promise<"cancelled" | "already_terminal" | "not_found">;
  markTerminal(outcome: WorkerTerminalOutcome): boolean;
}

const TAG = "exec-control";

class ExecutionControlImpl implements WorkerExecutionControl {
  readonly attemptId: string;
  readonly generation: number;
  readonly cardId: number;
  private _cancelled = false;
  private _cancelReason?: CancelReason;
  private _cancelFn: ((reason: CancelReason) => Promise<void> | void) | null = null;
  private _bound = false;
  private _terminal = false;
  private _terminalOutcome?: WorkerTerminalOutcome;

  constructor(attemptId: string, generation: number, cardId: number) {
    this.attemptId = attemptId;
    this.generation = generation;
    this.cardId = cardId;
  }

  get cancelled(): boolean { return this._cancelled; }
  get cancelReason(): CancelReason | undefined { return this._cancelReason; }
  get terminal(): boolean { return this._terminal; }
  get terminalOutcome(): WorkerTerminalOutcome | undefined { return this._terminalOutcome; }

  bind(cancel: (reason: CancelReason) => Promise<void> | void): boolean {
    if (this._bound) return false;
    this._bound = true;
    this._cancelFn = cancel;
    if (this._cancelled && this._cancelReason) {
      const reason = this._cancelReason;
      queueMicrotask(() => {
        void Promise.resolve(this._cancelFn!(reason)).catch(() => {});
      });
    }
    return true;
  }

  async requestCancel(reason: CancelReason): Promise<"cancelled" | "already_terminal" | "not_found"> {
    if (this._terminal) return "already_terminal";
    this._cancelled = true;
    this._cancelReason = reason;
    if (this._cancelFn) {
      await Promise.resolve(this._cancelFn(reason)).catch(() => {});
    }
    return "cancelled";
  }

  markTerminal(outcome: WorkerTerminalOutcome): boolean {
    if (this._terminal) return false;
    this._terminal = true;
    this._terminalOutcome = outcome;
    return true;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const _controls = new Map<string, ExecutionControlImpl>();

function key(attemptId: string, generation: number): string {
  return `${attemptId}:${generation}`;
}

export function registerControl(attemptId: string, generation: number, cardId: number): WorkerExecutionControl {
  const k = key(attemptId, generation);
  const existing = _controls.get(k);
  if (existing) return existing;
  const ctrl = new ExecutionControlImpl(attemptId, generation, cardId);
  _controls.set(k, ctrl);
  logDebug(TAG, `Registered control attempt=${attemptId} gen=${generation}`);
  return ctrl;
}

export function getControl(attemptId: string, generation: number): WorkerExecutionControl | undefined {
  return _controls.get(key(attemptId, generation));
}

export function removeControl(attemptId: string, generation: number): void {
  _controls.delete(key(attemptId, generation));
  logDebug(TAG, `Removed control attempt=${attemptId} gen=${generation}`);
}

export function removeControlByAttempt(attemptId: string): void {
  for (const [k, ctrl] of _controls) {
    if (ctrl.attemptId === attemptId) {
      _controls.delete(k);
      logDebug(TAG, `Removed control attempt=${attemptId} gen=${ctrl.generation}`);
    }
  }
}

export function hasLiveControl(attemptId: string, generation: number): boolean {
  const ctrl = _controls.get(key(attemptId, generation));
  if (!ctrl) return false;
  return !ctrl.terminal;
}
