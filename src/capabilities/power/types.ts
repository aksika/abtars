export type PowerBlockReason =
  | "recent_user_activity"
  | "active_execution"
  | "sleep_cycle_active"
  | "task_queue_busy"
  | "maintenance_active"
  | "outside_window"
  | "wake_not_verified"
  | "transition_active"
  | "unsupported_platform";

export interface PowerSafetyResult {
  safe: boolean;
  reasons: readonly PowerBlockReason[];
  checkedAt: number;
}

export interface PowerSafetyProbe {
  inspect(entry: { idleMinutes: number; latestLocalTime: string }): PowerSafetyResult;
}

export interface WakeVerification {
  verified: boolean;
  kind?: "wake" | "wakepoweron";
  localTime?: string;
  repeating?: boolean;
  reason?: string;
}

export type FixedCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface PowerAdapter {
  readonly platform: "darwin" | "linux";
  verifyWakeSchedule(expectedLocalTime: string): Promise<WakeVerification>;
  suspend(): Promise<void>;
}

export interface PowerTransitionState {
  state: "suspending";
  taskId: string;
  requestedAt: number;
  expiresAt: number;
  expectedWakeAt: number;
}

export interface HardwareSleepInspection {
  safe: boolean;
  reasons: readonly PowerBlockReason[];
  wake: WakeVerification | null;
  transition: PowerTransitionState | null;
  platform: string;
  suspendCommand: string;
}
