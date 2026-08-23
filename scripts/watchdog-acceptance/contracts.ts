/**
 * Watchdog E2E acceptance harness — shared contracts (#1712 Phase 0).
 *
 * Scenarios assert externally observable outcomes only: processes, bridge.lock
 * fields, supervisor.state, watchdog.log events, and exit statuses. No scenario
 * may depend on the watchdog's internal structure, shell variables, or any
 * future redesign draft. Timing differences are absorbed by timing profiles.
 */

export type ScenarioId = string;

export type ProcessRole = "watchdog" | "fixture" | "helper" | "canary";

export interface OwnedProcess {
  readonly pid: number;
  readonly startIdentity: string;
  readonly processGroupId: number;
  readonly role: ProcessRole;
  readonly home: string;
}

export type FixtureModeName =
  | "healthy"
  | "stale"
  | "exit"
  | "exit-stale-report"
  | "forge-exit"
  | "no-lock"
  | "non-owner"
  | "ignore-term"
  | "stale-ignore-term"
  | "transient";

export interface FixtureMode {
  readonly mode: FixtureModeName;
  readonly exitCode?: number;
  readonly delayMs?: number;
  /** forge-exit mode: the code planted into another owner's lock. */
  readonly forgedExitCode?: number;
  /** forge-exit mode: how old the forged report should look (ms). */
  readonly forgedExitAgeMs?: number;
}

export interface FixtureLiveControl {
  heartbeatEnabled: boolean;
  ignoreTerm: boolean;
  /**
   * When set, the LIVE fixture self-reports and exits after delayMs. `seq`
   * orders commands: a fixture only consumes exits with a seq greater than
   * the one already present when it started, so a respawned bridge never
   * executes its predecessor's stale command.
   */
  exit?: { code: number; delayMs?: number; staleReport?: boolean; seq?: number } | null;
}

export interface FixtureControlFile {
  defaultMode: FixtureMode;
  nextSpawns: Array<{ generation: number } & FixtureMode>;
  heartbeatMs: number;
  live: FixtureLiveControl;
}

/** Named, count-checked source transformations for the current implementation. */
export type TransformTarget = "watchdog" | "supervisor-state";

export interface SourceTransform {
  readonly target: TransformTarget;
  readonly find: string;
  readonly replace: string;
  readonly expectedCount: number;
}

export interface TimingProfile {
  readonly name: string;
  readonly transforms: readonly SourceTransform[];
}

export interface TimelineEntry {
  readonly t: number;
  readonly event: string;
  readonly detail?: string;
}

export interface AssertionFailureInfo {
  readonly message: string;
  readonly kind: "assertion" | "timeout" | "setup" | "cleanup";
}

export type ScenarioOutcome =
  | { status: "pass"; durationMs: number }
  | { status: "fail"; durationMs: number; failure: AssertionFailureInfo; timeline: TimelineEntry[] }
  | { status: "inconclusive"; durationMs: number; failure: AssertionFailureInfo; timeline: TimelineEntry[] };

export type ManifestExpectation =
  | { expect: "pass" }
  | { expect: "known-fail"; owner: string; reason: string }
  | { expect: "baseline-advisory"; reason: string };

export interface ExpectationManifest {
  sourceCommit: string | null;
  scenarios: Record<ScenarioId, ManifestExpectation>;
}

export type Verdict =
  | "ok"
  | "ok-known-fail"
  | "advisory"
  | "unexpected-pass"
  | "unexpected-fail"
  | "harness-failure";

export interface ScoreboardRow {
  readonly id: ScenarioId;
  readonly title: string;
  readonly outcomeStatus: ScenarioOutcome["status"];
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly expect: ManifestExpectation | null;
}

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly title: string;
  readonly profile: string;
  /** Higher-level group used for evidence organization only. */
  readonly run: (world: WorldApi) => Promise<void>;
}

/**
 * The world API scenarios use. Kept minimal and implementation-shaped so a
 * future watchdog design can swap the adapter without touching scenarios.
 */
export interface WorldApi {
  readonly root: string;
  homeA(): string;
  homeB(): string;
  artifactsDir(): string;

  seedHome(home: string): void;
  setControl(home: string, patch: Partial<FixtureControlFile>): void;
  claimNextGeneration(home: string): number;

  startWatchdog(home: string, extraEnv?: Record<string, string>): Promise<number>;
  plantBridge(home: string, mode: FixtureMode): Promise<number>;
  stopWatchdogGracefully(home: string, timeoutMs?: number): Promise<number>;
  watchdogExitCodeWhenAvailable(home: string): Promise<string | null>;
  pauseWatchdog(home: string): void;
  resumeWatchdog(home: string): void;

  supervisorCli(home: string, args: string[]): { code: number; stdout: string; stderr: string };
  lock(home: string): Record<string, unknown> | null;
  supervisorState(home: string): Record<string, unknown> | null;
  writeSupervisorState(home: string, state: Record<string, unknown>): void;
  watchdogLogLines(home: string, maxLines?: number): string[];
  flockInode(home: string): number | null;
  procSnapshot(pid: number): {
    pid: number;
    state: string;
    ppid: number;
    pgrp: number;
    comm: string;
    cmdline: string | null;
  } | null;
  processCwd(pid: number): string | null;
  listLiveBridgesByHome(home: string): number[];
  exitReportOf(home: string): { lastExitCode: unknown; lastExitAt: unknown };
  fixtureRegistryEntries(home: string): Array<{ pid: number; generation: number; mode: string }>;
  watchdogPidOf(home: string): number | null;
  signalWatchdogProcess(home: string, signal: NodeJS.Signals): void;
  runDoctor(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string };

  until(description: string, deadlineMs: number, predicate: () => boolean | Promise<boolean>): Promise<void>;
  sleep(ms: number): Promise<void>;
  timeline(event: string, detail?: string): void;

  expect(condition: boolean, message: string): void;
  expectEventually(deadlineMs: number, message: string, predicate: () => boolean | Promise<boolean>): Promise<void>;

  registry: RegistryApi;
}

export interface RegistryApi {
  spawn(opts: SpawnOptions): Promise<number>;
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Signal one validated PID without touching its process group. */
  signalPidOnly(pid: number, signal: NodeJS.Signals): void;
  get(pid: number): OwnedProcess | undefined;
  all(): readonly OwnedProcess[];
  isAlive(pid: number): boolean;
  cleanupAll(reason: string): Promise<void>;
  assertEmpty(): void;
  reapExited(): number[];
  size(): number;
}

export interface SpawnOptions {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly role: ProcessRole;
  readonly home: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdoutFile?: string;
}
