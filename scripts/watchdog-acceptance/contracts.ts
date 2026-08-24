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
  | "no-lock"
  | "non-owner"
  | "ignore-term"
  | "stale-ignore-term"
  | "transient"
  | "refuse-duplicate";

export interface FixtureMode {
  readonly mode: FixtureModeName;
  readonly exitCode?: number;
  readonly delayMs?: number;
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

/**
 * Evidence that a defect-covered scenario was measured RED against the
 * pre-fix commit before its entry was set to `pass` (R8.2). Without it a
 * first-appearance `pass` on an owned scenario is born green and is rejected.
 */
export interface RedBaselineEvidence {
  /** The pre-fix commit the red run was measured against. */
  readonly commit: string;
  /** Path (relative to this directory) of the committed red-run evidence. */
  readonly evidence: string;
}

export type ManifestExpectation =
  | { expect: "pass"; owner?: string; reason?: string; redBaseline?: RedBaselineEvidence }
  | { expect: "known-fail"; owner: string; reason: string }
  | { expect: "baseline-advisory"; reason: string };

/**
 * A mock (M) projection's manifest entry. Paired M/R cases share the contract
 * number and desired behavior but carry INDEPENDENT expectations: a helper
 * projection may pass while the real producer/wiring/process interaction
 * remains a known failure. M never substitutes for its R case.
 */
export interface MockExpectation {
  /** The stable A/B contract key this is a projection of (e.g. "A9"). */
  readonly contract: ScenarioId;
  /** The canonical real ID of the paired case (e.g. "RA09"). */
  readonly pairedReal: string;
  /** The shell-owned sub-invariant this projection actually asserts. */
  readonly projection: string;
  readonly expect: ManifestExpectation["expect"];
  readonly owner?: string;
  readonly reason?: string;
  readonly redBaseline?: RedBaselineEvidence;
}

export interface ExpectationManifest {
  sourceCommit: string | null;
  scenarios: Record<ScenarioId, ManifestExpectation>;
  /** Selected M projections; absence of an entry for a contract is intentional. */
  mockScenarios?: Record<ScenarioId, MockExpectation>;
}

export type Verdict =
  | "ok"
  | "ok-known-fail"
  | "advisory"
  | "unexpected-pass"
  | "unexpected-fail"
  | "harness-failure";

export interface ScoreboardRow {
  /** Durable A/B contract key (manifest/history key). */
  readonly id: ScenarioId;
  /** Canonical public display ID ("RA09"); equals `id` for non-R rows. */
  readonly publicId?: string;
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
  /**
   * Plant a LEGACY RELATIVE-spelled fixture (#1711 R2.1): argv
   * `app/bundle/abtars.js` resolved against `cwd` instead of the canonical
   * absolute target. Exercises the three-step attribution order (lock first,
   * then cwd, then unattributable) for the spawn-proof scope.
   */
  plantRelativeBridge(home: string, mode: FixtureMode, cwd: string): Promise<number>;
  stopWatchdogGracefully(home: string, timeoutMs?: number): Promise<number>;
  watchdogExitCodeWhenAvailable(home: string): Promise<string | null>;
  pauseWatchdog(home: string): void;
  resumeWatchdog(home: string): void;

  supervisorCli(home: string, args: string[]): { code: number; stdout: string; stderr: string };
  lock(home: string): Record<string, unknown> | null;
  supervisorState(home: string): Record<string, unknown> | null;
  writeSupervisorState(home: string, state: Record<string, unknown>): void;
  writeLock(home: string, lock: Record<string, unknown>): void;
  /**
   * Home with releases/r1+r2 and app->current->releases/r1 symlinks (B12).
   * Use instead of homeA()/homeB() — it replaces the flat layout.
   */
  homeWithReleases(label?: string): string;
  /** Atomically repoint <home>/current to the given release (B12). */
  repointRelease(home: string, release: string): void;
  /** Validated signal to a bridge process belonging to this home. */
  signalBridgeProcess(home: string, pid: number, signal: NodeJS.Signals): void;
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

// ── Public M/R identifiers and portfolio lanes (#1712 M/R migration) ────────
//
// The public identifier is `M` or `R` plus a two-digit contract number. The A/B
// key (A1-A24 / B1-B14) remains the durable history key for expected.json and
// git-backed born-green evidence; RA/RB are presentation/selection IDs.

export const TRACK_A_COUNT = 24;
export const TRACK_B_COUNT = 14;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "A9" -> "RA09"; null for anything that is not a valid A/B contract key. */
export function realPublicId(contractKey: string): string | null {
  const m = /^([AB])([1-9]\d*)$/.exec(contractKey);
  if (!m) return null;
  const n = Number(m[2]);
  if ((m[1] === "A" && n > TRACK_A_COUNT) || (m[1] === "B" && n > TRACK_B_COUNT)) return null;
  return `R${m[1]}${pad2(n)}`;
}

/** "RA09" -> "A9"; null for anything that is not a canonical real ID. */
export function contractKeyOfReal(publicId: string): string | null {
  return mockContractKeyOf(/^R([AB])(\d{2})$/.exec(publicId));
}

/** "MA09" -> "A9"; null for anything that is not a well-formed M ID shape. */
export function contractKeyOfMock(mockId: string): string | null {
  return mockContractKeyOf(/^M([AB])(\d{2})$/.exec(mockId));
}

function mockContractKeyOf(m: RegExpExecArray | null): string | null {
  if (!m) return null;
  const n = Number(m[2]);
  if (n === 0 || (m[1] === "A" && n > TRACK_A_COUNT) || (m[1] === "B" && n > TRACK_B_COUNT)) return null;
  return `${m[1]}${n}`;
}

/** All 38 real IDs in canonical serial order (A track, then B track). */
export const REAL_R_PUBLIC_IDS: readonly string[] = Object.freeze([
  ...Array.from({ length: TRACK_A_COUNT }, (_, i) => `RA${pad2(i + 1)}`),
  ...Array.from({ length: TRACK_B_COUNT }, (_, i) => `RB${pad2(i + 1)}`),
]);

/**
 * FAST R lane (run on every watchdog edit): cheap real scenarios per the
 * requirements artifact's saved timing data.
 */
export const FAST_R_PUBLIC_IDS: readonly string[] = Object.freeze([
  "RA01", "RA02", "RA10", "RA11", "RA13", "RA14", "RA15", "RA16",
  "RA18", "RA19", "RA23", "RB03", "RB04", "RB05", "RB06", "RB08",
]);

/** The 12 registered M projections; every one pairs a real case in the suite. */
export const MOCK_PROJECTION_IDS: readonly string[] = Object.freeze([
  "MA08", "MA09", "MA12", "MA20", "MA21", "MA24", "MB02", "MB09", "MB10", "MB11", "MB13", "MB14",
]);

/** SLOW R = the complement of FAST within the 38-case R portfolio (incl. RA08). */
export const SLOW_R_PUBLIC_IDS: readonly string[] = Object.freeze(
  REAL_R_PUBLIC_IDS.filter((id) => !FAST_R_PUBLIC_IDS.includes(id)),
);

export type SuiteName = "fast" | "slow" | "real";

export function suitePublicIds(suite: SuiteName): readonly string[] {
  switch (suite) {
    case "fast":
      return FAST_R_PUBLIC_IDS;
    case "slow":
      return SLOW_R_PUBLIC_IDS;
    case "real":
      return REAL_R_PUBLIC_IDS;
  }
}

/**
 * Resolve a `--only` selector to its canonical public ID + durable A/B key.
 * Canonical ("RA03"/"rb11") and legacy ("A3"/"B11") forms are both accepted;
 * the legacy form executes and reports under the canonical R ID.
 */
export function resolveScenarioSelector(arg: string): { publicId: string; contractKey: string } | null {
  const raw = arg.trim().toUpperCase();
  const fromReal = contractKeyOfReal(raw);
  if (fromReal) return { publicId: raw, contractKey: fromReal };
  const fromLegacy = realPublicId(raw);
  if (fromLegacy) return { publicId: fromLegacy, contractKey: raw };
  return null;
}

/**
 * Select the contract keys to run for one suite/focused request, preserving the
 * canonical serial order of `allKeysInOrder`. `onlyContractKey` wins over the
 * suite membership.
 */
export function selectScenarioContractKeys(
  suite: SuiteName,
  onlyContractKey: string | null,
  allKeysInOrder: readonly string[],
): string[] {
  if (onlyContractKey !== null) return allKeysInOrder.filter((k) => k === onlyContractKey);
  const members = new Set(suitePublicIds(suite));
  return allKeysInOrder.filter((k) => {
    const pub = realPublicId(k);
    return pub !== null && members.has(pub);
  });
}

// ── Runner CLI contract (#1712 Task 3) ──────────────────────────────────────

export class UsageError extends Error {}

export interface RunCliOptions {
  only: string | null;
  baseline: boolean;
  requireAllGreen: boolean;
  list: boolean;
  /** Default and "real" both retain the manifest-gated 38-case behavior. */
  suite: SuiteName;
}

export function parseRunArgs(argv: readonly string[]): RunCliOptions {
  const opts: RunCliOptions = { only: null, baseline: false, requireAllGreen: false, list: false, suite: "real" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--only") {
      const v = argv[i + 1];
      if (!v) throw new UsageError("--only requires a scenario id");
      opts.only = v;
      i++;
    } else if (a === "--baseline") {
      opts.baseline = true;
    } else if (a === "--require-all-green") {
      opts.requireAllGreen = true;
    } else if (a === "--list") {
      opts.list = true;
    } else if (a === "--suite") {
      const v = argv[i + 1];
      if (!v) throw new UsageError("--suite requires fast|slow|real");
      if (v !== "fast" && v !== "slow" && v !== "real") throw new UsageError(`unknown --suite value ${v}`);
      opts.suite = v;
      i++;
    } else {
      throw new UsageError(`unknown argument ${a}`);
    }
  }
  return opts;
}
