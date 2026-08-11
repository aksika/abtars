import type { AttemptLifecycle } from "./worker-supervision-store.js";

export const PRIORITY_BASE: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export const AGE_PROMOTION_MS = 60_000;

export const CAP_CRITICAL = 3;

export const ACTIVE_LIFECYCLES: readonly AttemptLifecycle[] = [
  "claimed",
  "starting",
  "running",
  "cancel_requested",
] as const;

export interface DispatchCandidate {
  cardId: number;
  projectId: number;
  priority: string;
  createdAt: string;
  attemptId: string;
  contractId: string;
  executorKind: string;
  executorId: string;
  generation: number;
  isRetry: boolean;
  sourceAttemptId?: string;
}

export function isActiveLifecycle(lc: AttemptLifecycle): boolean {
  return (ACTIVE_LIFECYCLES as readonly string[]).includes(lc);
}

export function computeEffectivePriority(priority: string, createdAt: string, now: number): number {
  const base = PRIORITY_BASE[priority] ?? PRIORITY_BASE.MEDIUM!;
  const createdMs = new Date(createdAt).getTime();
  const ageSteps = Math.floor(Math.max(0, now - createdMs) / AGE_PROMOTION_MS);
  return Math.min(CAP_CRITICAL, base + ageSteps);
}

export function minDefined(...values: (number | undefined | null)[]): number | undefined {
  const defined = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (defined.length === 0) return undefined;
  return Math.min(...defined);
}

export interface SchedulingPolicy {
  recovery: "process_bound" | "inspectable";
  defaultMaxDurationMs?: number;
  zeroCapacity?: boolean;
}

export const SPIN_POLICY: SchedulingPolicy = {
  recovery: "process_bound",
  defaultMaxDurationMs: 1_800_000,
};

export const PI_POLICY: SchedulingPolicy = {
  recovery: "inspectable",
};

export const REMOTE_POLICY: SchedulingPolicy = {
  recovery: "inspectable",
  zeroCapacity: true,
};

export function resolveSchedulingPolicy(executorKind: string): SchedulingPolicy {
  if (executorKind === "pi") return PI_POLICY;
  if (executorKind === "remote") return REMOTE_POLICY;
  return SPIN_POLICY;
}

export function deriveDeadline(
  claimedAt: string,
  executorPolicy: SchedulingPolicy,
  rootHardDeadlineAt?: string,
  workerMaxDurationMs?: number,
): string | undefined {
  const claimedMs = new Date(claimedAt).getTime();
  const effective = minDefined(
    rootHardDeadlineAt ? new Date(rootHardDeadlineAt).getTime() : undefined,
    workerMaxDurationMs ? claimedMs + workerMaxDurationMs : undefined,
    executorPolicy.defaultMaxDurationMs ? claimedMs + executorPolicy.defaultMaxDurationMs : undefined,
  );
  if (effective == null) return undefined;
  return new Date(effective).toISOString();
}
