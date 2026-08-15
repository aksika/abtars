/**
 * remote-swarm-live-contracts.ts — #1624 versioned wire contracts for the
 * live two-node swarm acceptance driver.
 *
 * Erasable-syntax only (no enums, namespaces, or parameter properties) so
 * the node probe can execute under plain `node` type stripping on deployed
 * hosts without a build step.
 *
 * Every validator is strict: unknown versions, unknown fields, missing IDs,
 * unbounded strings/arrays, absolute paths in evidence payloads, and
 * secret-shaped values are rejected. Node responses must match the role and
 * run ID of the command that produced them.
 */

export const REMOTE_SWARM_SCHEMA_VERSION = 1;
export const REMOTE_SWARM_MARKER_PREFIX = "testing, remote-swarm-e2e:";
export const REMOTE_SWARM_DEV_TEST_PREFIX = "[dev-test]";

export const REMOTE_SWARM_PROBE_RESULT_MARKER = "REMOTE_SWARM_NODE_RESULT=";
export const REMOTE_SWARM_PROBE_EVENT_MARKER = "REMOTE_SWARM_NODE_EVENT=";
export const REMOTE_SWARM_EVENT_MARKER = "REMOTE_SWARM_EVENT=";

/** Shared string bounds (bytes). */
export const CONTRACT_BOUNDS = {
  runId: 64,
  roleToken: 16,
  requestId: 128,
  contributionRef: 128,
  id: 128,
  hash: 96,
  peerName: 128,
  workspaceAlias: 64,
  goal: 4_000,
  message: 2_000,
  projectionString: 5_000,
  evidenceString: 2_000,
  tailLines: 200,
  tailBytes: 64_000,
  cards: 50,
  rows: 25,
  argvTokens: 64,
  argvToken: 2048,
} as const;

export const SAFE_ARGV_TOKEN = /^[A-Za-z0-9_./:@%+=,~-]+$/;

const SECRET_KEY_PATTERN = /(key|token|secret|password|signing|nonce|tribe|verify)[_-]?/i;
const SECRET_VALUE_PATTERN =
  /(BEGIN [A-Z ]*PRIVATE KEY|ENC:|sk-[A-Za-z0-9]{20,}|-----BEGIN)/;

export function looksSecretValue(value: string): boolean {
  if (SECRET_VALUE_PATTERN.test(value)) return true;
  // Long opaque tokens are suspicious UNLESS they are identifier-shaped
  // (run-scoped request ids, contribution refs) or pure lowercase hex
  // (sha256 digests) — both are evidence-shaped, never key material.
  const identifierShaped = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,127}$/.test(value);
  const digestShaped = /^[0-9a-f]{40,64}$/.test(value);
  if (value.length >= 40 && /^[A-Za-z0-9+/=_-]{40,}$/.test(value) && !identifierShaped && !digestShaped) {
    return true;
  }
  return false;
}

export function hasSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export type RemoteSwarmRole = "requester" | "receiver";
export type RemoteSwarmProfileName = "foundation" | "full";

export interface RemoteSwarmLiveProfileV1 {
  version: 1;
  requester: LiveNodeProfileV1;
  receiver: LiveNodeProfileV1;
  receiverPeerName: string;
  receiverWorkspaceAlias: string;
  evidenceRoot: string;
  deadlines?: { foundationMinutes?: number; fullMinutes?: number };
  tui?: { socketPath?: string };
}

export type LiveNodeProfileV1 = {
  role: RemoteSwarmRole;
  workdir: string;
  abtarsHome: string;
  cli?: string;
  node?: string;
  agentApiPort?: number;
} & (
  | { exec: { kind: "local" } }
  | { exec: { kind: "tmux"; session: string } }
);

export interface RemoteSwarmNodeCommandV1 {
  version: 1;
  role: RemoteSwarmRole;
  runId: string;
  command: "preflight" | "snapshot" | "remote-pi-control" | "log-tail";
  expectedCommit?: string;
  requirePiAlias?: string;
  marker?: string;
  requestIds?: string[];
  peer?: string;
  pi?: RemoteSwarmPiControlRequestV1;
  lines?: number;
}

export type RemoteSwarmPiControlAction =
  | "status"
  | "reply"
  | "steer"
  | "cancel"
  | "resume";

export interface RemoteSwarmResumeApprovalV1 {
  approvalId: string;
  runId: string;
  originPeer: string;
  commandId: string;
  approvingPrincipal: string;
  issuedAt: string;
  expiresAt: string;
  interruptedGeneration: number;
  approvalStatementSha256: string;
}

export interface RemoteSwarmPiControlRequestV1 {
  action: RemoteSwarmPiControlAction;
  piRunId: string;
  generation: number;
  commandId: string;
  requestId?: string;
  value?: unknown;
  instruction?: string;
  approval?: RemoteSwarmResumeApprovalV1;
}

export interface RemoteSwarmNodePreflightV1 {
  version: 1;
  role: RemoteSwarmRole;
  runId: string;
  probeSchemaVersion: number;
  nodeVersion: string;
  build: {
    manifestPresent: boolean;
    commit: string | null;
    branch: string | null;
    version: string | null;
    source: string | null;
    matchesExpected: boolean;
  };
  bridge: {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    heartbeatFresh: boolean;
    startIdentity: string | null;
    sleepStatus: string | null;
  };
  peerApi: {
    state: string | null;
    port: number | null;
    runtimeSnapshotPresent: boolean;
  };
  route: {
    expectedPeerRoute: boolean;
    authenticated: boolean;
    direction: string | null;
    connectedAt: string | null;
    otherRoutes: number;
  };
  enrollment: { selfEnrolled: boolean; peersCount: number };
  capabilities: {
    piExecutorConfigured: boolean;
    workspaceAliasPresent: boolean;
  };
  credentials: {
    transportJson: boolean;
    modelsJson: boolean;
    usersJson: boolean;
    providerSecretPresent: boolean;
    identityKeyPresent: boolean;
    peersJson: boolean;
  };
}

export interface RemoteSwarmCardFactV1 {
  id: number;
  type: string;
  status: string;
  source: string;
  sourceId: string | null;
  parentId: number | null;
  deliveryMode: string;
  deliveryResult: string | null;
  resultSummary: string | null;
  markerPresent: boolean;
  notesRequestId: string | null;
  notesContributionRef: string | null;
  notesOutcome: string | null;
  notesRemoteRunId: string | null;
  notesHelpDecision: string | null;
}

export interface RemoteSwarmContributionFactV1 {
  requestId: string;
  contributionRef: string;
  requestHash: string;
  state: string;
  lastSequence: number;
  terminalEventId: string | null;
  terminalDigest: string | null;
  projection: {
    outcome: string | null;
    receiverProjectRef: string | null;
    acceptanceId: string | null;
    acceptedAt: string | null;
  } | null;
}

export interface RemoteSwarmEventFactV1 {
  eventId: string;
  requestId: string;
  contributionRef: string;
  sequence: number;
  kind: string;
  payloadDigest: string;
}

export interface RemoteSwarmHelpRequestFactV1 {
  requestId: string;
  contributionRef: string | null;
  state: string;
  localCardId: number | null;
  localRunId: string | null;
  responseDecision: string | null;
  reasonCode: string | null;
  provesNonCreation: boolean | null;
  requestHash: string;
}

export interface RemoteSwarmSupervisionFactV1 {
  projectCardId: number;
  state: string;
  generation: number;
  reviewRound: number;
  activeReviewCaseId: string | null;
  acceptedDecisionId: string | null;
  blockedReason: string | null;
}

export interface RemoteSwarmReviewCaseFactV1 {
  id: string;
  projectCardId: number;
  generation: number;
  round: number;
  status: string;
  snapshotDigest: string;
}

export interface RemoteSwarmReviewDecisionFactV1 {
  id: string;
  reviewCaseId: string;
  projectCardId: number;
  action: string | null;
}

export interface RemoteSwarmOutboxFactV1 {
  id: string;
  projectCardId: number;
  attempts: number;
  sentAt: string | null;
  lastError: string | null;
}

export interface RemoteSwarmPiRunFactV1 {
  runId: string;
  cardId: number | null;
  status: string;
  generation: number;
  originRequestId: string | null;
  workspaceAlias: string | null;
  resumeCapability: string | null;
  generationIntent: string | null;
}

export interface RemoteSwarmPiEventFactV1 {
  runId: string;
  sequence: number;
  kind: string;
  generation: number;
  acknowledgedAt: string | null;
  eventId: string | null;
}

export interface RemoteSwarmPiOriginFactV1 {
  runId: string;
  originRequestId: string | null;
  latestSequence: number;
  acknowledgedSequence: number;
  latestGeneration: number;
  latestStatus: string;
  resumeCapability: string | null;
  pendingInputPresent: boolean;
  resultSummary: string | null;
  errorSummary: string | null;
}

export interface RemoteSwarmPiCommandFactV1 {
  commandId: string;
  runId: string;
  state: string;
  payloadHash: string;
}

export interface RemoteSwarmPiRequestFactV1 {
  requestId: string;
  operation: string;
  state: string;
}

export interface RemoteSwarmClaimFactV1 {
  runId: string;
  generation: number;
  ownerKind: string;
}

export interface RemoteSwarmWorkerAttemptFactV1 {
  cardId: number;
  executorKind: string;
  executorId: string;
  generation: number;
  lifecycle: string;
}

export interface RemoteSwarmProcessFactV1 {
  runId: string;
  observedPidPresent: boolean;
  sessionPresent: boolean;
  resumeCapability: string | null;
  generationIntent: string | null;
}

export interface RemoteSwarmSnapshotV1 {
  version: 1;
  role: RemoteSwarmRole;
  runId: string;
  at: string;
  requestIds: string[];
  cards: RemoteSwarmCardFactV1[];
  contributions: RemoteSwarmContributionFactV1[];
  contributionEvents: RemoteSwarmEventFactV1[];
  helpRequests: RemoteSwarmHelpRequestFactV1[];
  supervisions: RemoteSwarmSupervisionFactV1[];
  reviewCases: RemoteSwarmReviewCaseFactV1[];
  reviewDecisions: RemoteSwarmReviewDecisionFactV1[];
  acceptanceOutbox: RemoteSwarmOutboxFactV1[];
  piRuns: RemoteSwarmPiRunFactV1[];
  piEvents: RemoteSwarmPiEventFactV1[];
  piOriginProjections: RemoteSwarmPiOriginFactV1[];
  piOriginEvents: RemoteSwarmPiEventFactV1[];
  piCommands: RemoteSwarmPiCommandFactV1[];
  piApiRequests: RemoteSwarmPiRequestFactV1[];
  workspaceClaims: RemoteSwarmClaimFactV1[];
  workerAttempts: RemoteSwarmWorkerAttemptFactV1[];
  processFacts: RemoteSwarmProcessFactV1[];
}

export interface RemoteSwarmPiControlResultV1 {
  version: 1;
  role: "requester";
  runId: string;
  action: RemoteSwarmPiControlAction;
  outcome: "succeeded" | "rejected" | "outcome_unknown" | "transport_error" | "invalid_request";
  error: { code: string; message: string } | null;
  projection: {
    status: string | null;
    generation: number | null;
    cursor: number | null;
    resumeCapability: string | null;
  } | null;
}

export interface RemoteSwarmLogTailV1 {
  version: 1;
  role: RemoteSwarmRole;
  runId: string;
  truncated: boolean;
  tail: string;
}

export type RemoteSwarmNodeResultV1 =
  | { kind: "preflight"; value: RemoteSwarmNodePreflightV1 }
  | { kind: "snapshot"; value: RemoteSwarmSnapshotV1 }
  | { kind: "control"; value: RemoteSwarmPiControlResultV1 }
  | { kind: "log-tail"; value: RemoteSwarmLogTailV1 };

export interface RemoteSwarmScenarioResultV1 {
  id: string;
  name: string;
  state: "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  failure: { stage: string; code: string; message: string } | null;
  evidence: Array<{ kind: string; id: string }>;
}

export interface RemoteSwarmCleanupAssertionV1 {
  id: string;
  passed: boolean;
  detail: string;
}

export interface RemoteSwarmCleanupResultV1 {
  state: "passed" | "failed" | "blocked";
  assertions: RemoteSwarmCleanupAssertionV1[];
}

export interface RemoteSwarmLiveResultV1 {
  version: 1;
  runId: string;
  profile: RemoteSwarmProfileName;
  expectedCommit: string;
  requesterBuild: string;
  receiverBuild: string;
  startedAt: string;
  finishedAt: string;
  state: "passed" | "failed" | "blocked";
  scenarios: RemoteSwarmScenarioResultV1[];
  cleanup: RemoteSwarmCleanupResultV1;
  failure: { stage: string; code: string; message: string } | null;
}

export interface RemoteSwarmEventRecordV1 {
  ts: string;
  stage: string;
  node: RemoteSwarmRole | "controller";
  message: string;
  meta?: Record<string, unknown>;
}

// ── Validator toolkit ─────────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function expectObject(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("expected an object");
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

export function expectString(
  raw: unknown,
  field: string,
  opts: { min?: number; max?: number; pattern?: RegExp } = {},
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return fail(`${field} must be a string`);
  if (opts.min !== undefined && raw.length < opts.min) return fail(`${field} too short`);
  if (opts.max !== undefined && raw.length > opts.max) return fail(`${field} too long (${raw.length} > ${opts.max})`);
  if (opts.pattern && !opts.pattern.test(raw)) return fail(`${field} does not match ${opts.pattern}`);
  return { ok: true, value: raw };
}

export function expectNumber(
  raw: unknown,
  field: string,
  opts: { min?: number; max?: number; int?: boolean } = {},
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof raw !== "number" || Number.isNaN(raw)) return fail(`${field} must be a number`);
  if (opts.min !== undefined && raw < opts.min) return fail(`${field} too small`);
  if (opts.max !== undefined && raw > opts.max) return fail(`${field} too large`);
  if (opts.int && !Number.isInteger(raw)) return fail(`${field} must be an integer`);
  return { ok: true, value: raw };
}

export function expectBoolean(
  raw: unknown,
  field: string,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof raw !== "boolean") return fail(`${field} must be a boolean`);
  return { ok: true, value: raw };
}

export function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
): { ok: true } | { ok: false; error: string } {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return fail(`unknown field "${key}"`);
  }
  return { ok: true };
}

export function rejectEvidenceLeak(
  obj: Record<string, unknown>,
  path: string,
): { ok: true } | { ok: false; error: string } {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      if (hasSecretKey(key) && !/^(peer|originPeer|ownerPeer|peerName)$/i.test(key)) {
        const opaque = /^[A-Za-z0-9_.:\-]{1,128}$/.test(value);
        const hashed = /^[A-Za-z0-9+/=_-]{20,96}$/.test(value);
        if (!opaque && !hashed) {
          return fail(`evidence field "${key}" at ${path} is secret-shaped`);
        }
      }
      if (looksSecretValue(value)) {
        return fail(`evidence field "${key}" at ${path} carries a secret-shaped value`);
      }
      if (isAbsolutePath(value)) {
        return fail(`evidence field "${key}" at ${path} carries an absolute path`);
      }
    } else if (value !== null && typeof value === "object") {
      const nested = rejectEvidenceLeak(value as Record<string, unknown>, `${path}.${key}`);
      if (!nested.ok) return nested;
    }
  }
  return { ok: true };
}

export function rejectAbsolutePathsDeep(value: unknown, path: string): { ok: true } | { ok: false; error: string } {
  if (typeof value === "string") {
    if (isAbsolutePath(value)) return fail(`absolute path in evidence at ${path}`);
    return { ok: true };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = rejectAbsolutePathsDeep(value[i], `${path}[${i}]`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = rejectAbsolutePathsDeep(v, `${path}.${k}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: true };
}

export function isSafeArgvToken(token: string): boolean {
  return token.length > 0 && token.length <= CONTRACT_BOUNDS.argvToken && SAFE_ARGV_TOKEN.test(token);
}

// ── Profile validator ────────────────────────────────────────────────────────

export function validateProfile(raw: unknown): ValidationResult<RemoteSwarmLiveProfileV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["version", "requester", "receiver", "receiverPeerName", "receiverWorkspaceAlias", "evidenceRoot", "deadlines", "tui"]);
  if (!allow.ok) return allow;
  if (obj.value.version !== 1) return fail("unsupported profile version (expected 1)");
  const receiverPeerName = expectString(obj.value.receiverPeerName, "receiverPeerName", { min: 1, max: CONTRACT_BOUNDS.peerName });
  if (!receiverPeerName.ok) return receiverPeerName;
  const receiverWorkspaceAlias = expectString(obj.value.receiverWorkspaceAlias, "receiverWorkspaceAlias", { min: 1, max: CONTRACT_BOUNDS.workspaceAlias, pattern: /^[a-z][a-z0-9_.\-]{0,63}$/ });
  if (!receiverWorkspaceAlias.ok) return receiverWorkspaceAlias;
  const evidenceRoot = expectString(obj.value.evidenceRoot, "evidenceRoot", { min: 1, max: 512 });
  if (!evidenceRoot.ok) return evidenceRoot;
  if (!isAbsolutePath(evidenceRoot.value)) return fail("evidenceRoot must be absolute");
  if (evidenceRoot.value === "/" || evidenceRoot.value.startsWith("/root") || evidenceRoot.value.startsWith("/home/root")) {
    return fail("evidenceRoot must be a non-root absolute path");
  }

  const requester = validateNodeProfile(obj.value.requester, "requester");
  if (!requester.ok) return requester;
  if (requester.value.role !== "requester") return fail("requester node must have role requester");
  const receiver = validateNodeProfile(obj.value.receiver, "receiver");
  if (!receiver.ok) return receiver;
  if (receiver.value.role !== "receiver") return fail("receiver node must have role receiver");

  const deadlines: RemoteSwarmLiveProfileV1["deadlines"] = {};
  if (obj.value.deadlines !== undefined) {
    const dlObj = expectObject(obj.value.deadlines);
    if (!dlObj.ok) return fail("deadlines must be an object");
    const dlAllow = rejectUnknownFields(dlObj.value, ["foundationMinutes", "fullMinutes"]);
    if (!dlAllow.ok) return dlAllow;
    if (dlObj.value.foundationMinutes !== undefined) {
      const m = expectNumber(dlObj.value.foundationMinutes, "foundationMinutes", { min: 1, max: 240, int: true });
      if (!m.ok) return m;
      deadlines.foundationMinutes = m.value;
    }
    if (dlObj.value.fullMinutes !== undefined) {
      const m = expectNumber(dlObj.value.fullMinutes, "fullMinutes", { min: 1, max: 480, int: true });
      if (!m.ok) return m;
      deadlines.fullMinutes = m.value;
    }
  }

  const tui: RemoteSwarmLiveProfileV1["tui"] = {};
  if (obj.value.tui !== undefined) {
    const tuiObj = expectObject(obj.value.tui);
    if (!tuiObj.ok) return fail("tui must be an object");
    const tuiAllow = rejectUnknownFields(tuiObj.value, ["socketPath"]);
    if (!tuiAllow.ok) return tuiAllow;
    if (tuiObj.value.socketPath !== undefined) {
      const p = expectString(tuiObj.value.socketPath, "tui.socketPath", { min: 1, max: 512 });
      if (!p.ok) return p;
      if (!isAbsolutePath(p.value)) return fail("tui.socketPath must be absolute");
      tui.socketPath = p.value;
    }
  }

  return {
    ok: true,
    value: {
      version: 1,
      requester: requester.value,
      receiver: receiver.value,
      receiverPeerName: receiverPeerName.value,
      receiverWorkspaceAlias: receiverWorkspaceAlias.value,
      evidenceRoot: evidenceRoot.value,
      deadlines: Object.keys(deadlines).length > 0 ? deadlines : undefined,
      tui: Object.keys(tui).length > 0 ? tui : undefined,
    },
  };
}

function validateNodeProfile(raw: unknown, field: string): ValidationResult<LiveNodeProfileV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["role", "workdir", "abtarsHome", "exec", "cli", "node", "agentApiPort"]);
  if (!allow.ok) return allow;
  const role = expectString(obj.value.role, `${field}.role`, { max: CONTRACT_BOUNDS.roleToken });
  if (!role.ok) return role;
  if (role.value !== "requester" && role.value !== "receiver") return fail(`${field}.role must be requester or receiver`);
  const workdir = expectString(obj.value.workdir, `${field}.workdir`, { min: 1, max: 512 });
  if (!workdir.ok) return workdir;
  if (!isAbsolutePath(workdir.value)) return fail(`${field}.workdir must be absolute`);
  if (workdir.value === "/" || workdir.value.startsWith("/root") || workdir.value.startsWith("/home/root")) {
    return fail(`${field}.workdir must be a non-root absolute path`);
  }
  const abtarsHome = expectString(obj.value.abtarsHome, `${field}.abtarsHome`, { min: 1, max: 512 });
  if (!abtarsHome.ok) return abtarsHome;
  if (!isAbsolutePath(abtarsHome.value)) return fail(`${field}.abtarsHome must be absolute`);
  const execObj = expectObject(obj.value.exec);
  if (!execObj.ok) return fail(`${field}.exec must be an object`);
  const kind = expectString(execObj.value.kind, `${field}.exec.kind`, { min: 1, max: 16 });
  if (!kind.ok) return kind;
  if (kind.value !== "local" && kind.value !== "tmux") return fail(`${field}.exec.kind must be local or tmux`);
  const base: { role: RemoteSwarmRole; workdir: string; abtarsHome: string; cli?: string; node?: string; agentApiPort?: number } = {
    role: role.value as RemoteSwarmRole,
    workdir: workdir.value,
    abtarsHome: abtarsHome.value,
  };
  if (obj.value.cli !== undefined) {
    const cli = expectString(obj.value.cli, `${field}.cli`, { min: 1, max: 64, pattern: /^[A-Za-z0-9._\-]+$/ });
    if (!cli.ok) return cli;
    base.cli = cli.value;
  }
  if (obj.value.node !== undefined) {
    const node = expectString(obj.value.node, `${field}.node`, { min: 1, max: 512 });
    if (!node.ok) return node;
    if (!isAbsolutePath(node.value) && !isSafeArgvToken(node.value)) {
      return fail(`${field}.node must be an absolute path or a bare token`);
    }
    base.node = node.value;
  }
  if (obj.value.agentApiPort !== undefined) {
    const port = expectNumber(obj.value.agentApiPort, `${field}.agentApiPort`, { min: 1, max: 65_535, int: true });
    if (!port.ok) return port;
    base.agentApiPort = port.value;
  }

  if (kind.value === "tmux") {
    const session = expectString(execObj.value.session, `${field}.exec.session`, { min: 1, max: 64, pattern: /^[A-Za-z0-9._\-]+$/ });
    if (!session.ok) return session;
    const tmuxNode: LiveNodeProfileV1 = {
      role: base.role,
      workdir: base.workdir,
      abtarsHome: base.abtarsHome,
      exec: { kind: "tmux", session: session.value },
      cli: base.cli,
      node: base.node,
      agentApiPort: base.agentApiPort,
    };
    return { ok: true, value: tmuxNode };
  }
  const localNode: LiveNodeProfileV1 = {
    role: base.role,
    workdir: base.workdir,
    abtarsHome: base.abtarsHome,
    exec: { kind: "local" },
    cli: base.cli,
    node: base.node,
    agentApiPort: base.agentApiPort,
  };
  return { ok: true, value: localNode };
}

// ── Node command validator ───────────────────────────────────────────────────

export function validateNodeCommand(raw: unknown): ValidationResult<RemoteSwarmNodeCommandV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["version", "role", "runId", "command", "expectedCommit", "requirePiAlias", "marker", "requestIds", "peer", "pi", "lines"]);
  if (!allow.ok) return allow;
  if (obj.value.version !== 1) return fail("unsupported node command version (expected 1)");
  const role = expectString(obj.value.role, "role", { max: CONTRACT_BOUNDS.roleToken });
  if (!role.ok) return role;
  if (role.value !== "requester" && role.value !== "receiver") return fail("role must be requester or receiver");
  const runId = expectString(obj.value.runId, "runId", { min: 3, max: CONTRACT_BOUNDS.runId, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ });
  if (!runId.ok) return runId;
  const command = expectString(obj.value.command, "command", { max: 32 });
  if (!command.ok) return command;
  const allowedCommands = ["preflight", "snapshot", "remote-pi-control", "log-tail"];
  if (!allowedCommands.includes(command.value)) return fail(`unknown command "${command.value}"`);
  if (command.value === "remote-pi-control" && role.value !== "requester") {
    return fail("remote-pi-control is only valid on the requester node");
  }
  const result: RemoteSwarmNodeCommandV1 = {
    version: 1,
    role: role.value as RemoteSwarmRole,
    runId: runId.value,
    command: command.value as RemoteSwarmNodeCommandV1["command"],
  };
  if (obj.value.expectedCommit !== undefined) {
    const v = expectString(obj.value.expectedCommit, "expectedCommit", { min: 4, max: 64, pattern: /^[0-9a-f]{4,64}$/i });
    if (!v.ok) return v;
    result.expectedCommit = v.value;
  }
  if (obj.value.requirePiAlias !== undefined) {
    const v = expectString(obj.value.requirePiAlias, "requirePiAlias", { min: 1, max: CONTRACT_BOUNDS.workspaceAlias, pattern: /^[a-z][a-z0-9_.\-]{0,63}$/ });
    if (!v.ok) return v;
    result.requirePiAlias = v.value;
  }
  if (obj.value.marker !== undefined) {
    const v = expectString(obj.value.marker, "marker", { min: 1, max: CONTRACT_BOUNDS.goal });
    if (!v.ok) return v;
    result.marker = v.value;
  }
  if (obj.value.requestIds !== undefined) {
    if (!Array.isArray(obj.value.requestIds)) return fail("requestIds must be an array");
    if (obj.value.requestIds.length > 32) return fail("requestIds too long");
    const ids: string[] = [];
    for (const id of obj.value.requestIds) {
      const v = expectString(id, "requestIds[]", { min: 1, max: CONTRACT_BOUNDS.requestId, pattern: /^[A-Za-z0-9._:\-]+$/ });
      if (!v.ok) return v;
      ids.push(v.value);
    }
    result.requestIds = ids;
  }
  if (obj.value.peer !== undefined) {
    const v = expectString(obj.value.peer, "peer", { min: 1, max: CONTRACT_BOUNDS.peerName });
    if (!v.ok) return v;
    result.peer = v.value;
  }
  if (obj.value.pi !== undefined) {
    const pi = validatePiControlRequest(obj.value.pi, "pi");
    if (!pi.ok) return pi;
    result.pi = pi.value;
  }
  if (obj.value.lines !== undefined) {
    const v = expectNumber(obj.value.lines, "lines", { min: 1, max: CONTRACT_BOUNDS.tailLines, int: true });
    if (!v.ok) return v;
    result.lines = v.value;
  }
  return { ok: true, value: result };
}

export function validatePiControlRequest(raw: unknown, field: string): ValidationResult<RemoteSwarmPiControlRequestV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["action", "piRunId", "generation", "commandId", "requestId", "value", "instruction", "approval"]);
  if (!allow.ok) return allow;
  const action = expectString(obj.value.action, `${field}.action`, { max: 16 });
  if (!action.ok) return action;
  const actions: RemoteSwarmPiControlAction[] = ["status", "reply", "steer", "cancel", "resume"];
  if (!actions.includes(action.value as RemoteSwarmPiControlAction)) return fail(`${field}.action must be one of ${actions.join(",")}`);
  const piRunId = expectString(obj.value.piRunId, `${field}.piRunId`, { min: 1, max: CONTRACT_BOUNDS.id, pattern: /^[A-Za-z0-9._:\-]+$/ });
  if (!piRunId.ok) return piRunId;
  const generation = expectNumber(obj.value.generation, `${field}.generation`, { min: 1, max: 1_000_000, int: true });
  if (!generation.ok) return generation;
  const commandId = expectString(obj.value.commandId, `${field}.commandId`, { min: 1, max: CONTRACT_BOUNDS.id, pattern: /^[A-Za-z0-9._:\-]+$/ });
  if (!commandId.ok) return commandId;
  const result: RemoteSwarmPiControlRequestV1 = {
    action: action.value as RemoteSwarmPiControlAction,
    piRunId: piRunId.value,
    generation: generation.value,
    commandId: commandId.value,
  };
  if (obj.value.requestId !== undefined) {
    const v = expectString(obj.value.requestId, `${field}.requestId`, { min: 1, max: CONTRACT_BOUNDS.requestId, pattern: /^[A-Za-z0-9._:\-]+$/ });
    if (!v.ok) return v;
    result.requestId = v.value;
  }
  if (obj.value.instruction !== undefined) {
    const v = expectString(obj.value.instruction, `${field}.instruction`, { min: 1, max: 2_000 });
    if (!v.ok) return v;
    result.instruction = v.value;
  }
  if (obj.value.approval !== undefined) {
    const approval = validateResumeApproval(obj.value.approval, `${field}.approval`);
    if (!approval.ok) return approval;
    result.approval = approval.value;
  }
  if (obj.value.value !== undefined) {
    const json = JSON.stringify(obj.value.value);
    if (json.length > 10_000) return fail(`${field}.value too large`);
    result.value = obj.value.value;
  }
  return { ok: true, value: result };
}

export function validateResumeApproval(raw: unknown, field: string): ValidationResult<RemoteSwarmResumeApprovalV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["approvalId", "runId", "originPeer", "commandId", "approvingPrincipal", "issuedAt", "expiresAt", "interruptedGeneration", "approvalStatementSha256"]);
  if (!allow.ok) return allow;
  const stringFields: Array<[string, number]> = [
    ["approvalId", CONTRACT_BOUNDS.id],
    ["runId", CONTRACT_BOUNDS.id],
    ["originPeer", CONTRACT_BOUNDS.peerName],
    ["commandId", CONTRACT_BOUNDS.id],
    ["approvingPrincipal", CONTRACT_BOUNDS.peerName],
    ["issuedAt", 64],
    ["expiresAt", 64],
    ["approvalStatementSha256", 128],
  ];
  const value: Record<string, unknown> = {};
  for (const [key, max] of stringFields) {
    const v = expectString(obj.value[key], `${field}.${key}`, { min: 1, max });
    if (!v.ok) return v;
    value[key] = v.value;
  }
  const interruptedGeneration = expectNumber(obj.value.interruptedGeneration, `${field}.interruptedGeneration`, { min: 1, max: 1_000_000, int: true });
  if (!interruptedGeneration.ok) return interruptedGeneration;
  return {
    ok: true,
    value: {
      approvalId: value["approvalId"] as string,
      runId: value["runId"] as string,
      originPeer: value["originPeer"] as string,
      commandId: value["commandId"] as string,
      approvingPrincipal: value["approvingPrincipal"] as string,
      issuedAt: value["issuedAt"] as string,
      expiresAt: value["expiresAt"] as string,
      interruptedGeneration: interruptedGeneration.value,
      approvalStatementSha256: value["approvalStatementSha256"] as string,
    },
  };
}

// ── Node result validators ───────────────────────────────────────────────────

export function validateNodeResult(raw: unknown, expectedRole: RemoteSwarmRole, expectedRunId: string): ValidationResult<RemoteSwarmNodeResultV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["kind", "value"]);
  if (!allow.ok) return allow;
  const kind = expectString(obj.value.kind, "kind", { max: 16 });
  if (!kind.ok) return kind;
  const valueObj = expectObject(obj.value.value);
  if (!valueObj.ok) return fail("node result value must be an object");
  if (valueObj.value.version !== 1) return fail("unsupported node result version (expected 1)");
  const role = expectString(valueObj.value.role, "value.role", { max: CONTRACT_BOUNDS.roleToken });
  if (!role.ok) return role;
  if (role.value !== expectedRole) return fail(`node result role ${role.value} does not match command role ${expectedRole}`);
  const runId = expectString(valueObj.value.runId, "value.runId", { min: 3, max: CONTRACT_BOUNDS.runId });
  if (!runId.ok) return runId;
  if (runId.value !== expectedRunId) return fail(`node result runId ${runId.value} does not match command runId ${expectedRunId}`);

  switch (kind.value) {
    case "preflight":
      return { ok: true, value: { kind: "preflight", value: validatePreflight(valueObj.value) } };
    case "snapshot":
      return { ok: true, value: { kind: "snapshot", value: validateSnapshot(valueObj.value) } };
    case "control": {
      const c = validatePiControlResult(valueObj.value);
      if (!c.ok) return c;
      return { ok: true, value: { kind: "control", value: c.value } };
    }
    case "log-tail": {
      const l = validateLogTail(valueObj.value);
      if (!l.ok) return l;
      return { ok: true, value: { kind: "log-tail", value: l.value } };
    }
    default:
      return fail(`unknown node result kind "${kind.value}"`);
  }
}
function expectPreflightGroup(raw: Record<string, unknown>, group: string): Record<string, unknown> {
  const g = raw[group];
  if (g === null || typeof g !== "object" || Array.isArray(g)) throw new Error(`preflight ${group} invalid`);
  const fields = g as Record<string, unknown>;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "boolean") continue;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12) continue;
    if (typeof v === "string" && v.length <= 512) continue;
    if (v !== null) throw new Error(`preflight ${group}.${k} invalid`);
  }
  return fields;
}

function validatePreflight(raw: Record<string, unknown>): RemoteSwarmNodePreflightV1 {
  const value: Record<string, unknown> = {
    nodeVersion: raw.nodeVersion,
    probeSchemaVersion: raw.probeSchemaVersion,
  };
  if (typeof value.nodeVersion !== "string" || value.nodeVersion.length > 64) throw new Error("preflight nodeVersion invalid");
  if (typeof value.probeSchemaVersion !== "number" || value.probeSchemaVersion !== 1) throw new Error("preflight probeSchemaVersion invalid");
  const build = expectPreflightGroup(raw, "build");
  if (typeof build.matchesExpected !== "boolean") throw new Error("preflight build.matchesExpected invalid");
  if (typeof build.manifestPresent !== "boolean") throw new Error("preflight build.manifestPresent invalid");
  const bridge = expectPreflightGroup(raw, "bridge");
  if (typeof bridge.running !== "boolean") throw new Error("preflight bridge.running invalid");
  if (typeof bridge.heartbeatFresh !== "boolean") throw new Error("preflight bridge.heartbeatFresh invalid");
  if (typeof bridge.pid !== "number" && bridge.pid !== null) throw new Error("preflight bridge.pid invalid");
  if (typeof bridge.startedAt !== "string" && bridge.startedAt !== null) throw new Error("preflight bridge.startedAt invalid");
  const peerApi = expectPreflightGroup(raw, "peerApi");
  if (typeof peerApi.runtimeSnapshotPresent !== "boolean") throw new Error("preflight peerApi.runtimeSnapshotPresent invalid");
  if (typeof peerApi.port !== "number" && peerApi.port !== null) throw new Error("preflight peerApi.port invalid");
  if (typeof peerApi.state !== "string" && peerApi.state !== null) throw new Error("preflight peerApi.state invalid");
  const route = expectPreflightGroup(raw, "route");
  if (typeof route.expectedPeerRoute !== "boolean") throw new Error("preflight route.expectedPeerRoute invalid");
  if (typeof route.authenticated !== "boolean") throw new Error("preflight route.authenticated invalid");
  if (typeof route.otherRoutes !== "number" || !Number.isInteger(route.otherRoutes)) throw new Error("preflight route.otherRoutes invalid");
  if (typeof route.direction !== "string" && route.direction !== null) throw new Error("preflight route.direction invalid");
  if (typeof route.connectedAt !== "string" && route.connectedAt !== null) throw new Error("preflight route.connectedAt invalid");
  const enrollment = expectPreflightGroup(raw, "enrollment");
  if (typeof enrollment.selfEnrolled !== "boolean") throw new Error("preflight enrollment.selfEnrolled invalid");
  if (typeof enrollment.peersCount !== "number" || !Number.isInteger(enrollment.peersCount)) throw new Error("preflight enrollment.peersCount invalid");
  const capabilities = expectPreflightGroup(raw, "capabilities");
  if (typeof capabilities.piExecutorConfigured !== "boolean") throw new Error("preflight capabilities.piExecutorConfigured invalid");
  if (typeof capabilities.workspaceAliasPresent !== "boolean") throw new Error("preflight capabilities.workspaceAliasPresent invalid");
  const credentials = expectPreflightGroup(raw, "credentials");
  for (const key of ["transportJson", "modelsJson", "usersJson", "providerSecretPresent", "identityKeyPresent", "peersJson"]) {
    if (typeof credentials[key] !== "boolean") throw new Error(`preflight credentials.${key} invalid`);
  }
  const leak = rejectEvidenceLeak(raw, "preflight");
  if (!leak.ok) throw new Error(leak.error);
  return raw as unknown as RemoteSwarmNodePreflightV1;
}

function validateSnapshot(raw: Record<string, unknown>): RemoteSwarmSnapshotV1 {
  const required = [
    "at", "requestIds", "cards", "contributions", "contributionEvents", "helpRequests",
    "supervisions", "reviewCases", "reviewDecisions", "acceptanceOutbox", "piRuns",
    "piEvents", "piOriginProjections", "piOriginEvents", "piCommands", "piApiRequests",
    "workspaceClaims", "workerAttempts", "processFacts",
  ];
  for (const key of required) {
    if (!(key in raw)) throw new Error(`snapshot missing ${key}`);
  }
  if (typeof raw.at !== "string" || raw.at.length > 64) throw new Error("snapshot at invalid");
  if (!Array.isArray(raw.requestIds)) throw new Error("snapshot requestIds invalid");
  if (raw.requestIds.length > 32) throw new Error("snapshot requestIds too long");
  for (const id of raw.requestIds) {
    if (typeof id !== "string" || id.length > CONTRACT_BOUNDS.requestId) throw new Error("snapshot requestId invalid");
  }
  const arrayBounds: Record<string, number> = {
    cards: CONTRACT_BOUNDS.cards,
    contributions: CONTRACT_BOUNDS.rows,
    contributionEvents: CONTRACT_BOUNDS.rows,
    helpRequests: CONTRACT_BOUNDS.rows,
    supervisions: CONTRACT_BOUNDS.rows,
    reviewCases: CONTRACT_BOUNDS.rows,
    reviewDecisions: CONTRACT_BOUNDS.rows,
    acceptanceOutbox: CONTRACT_BOUNDS.rows,
    piRuns: CONTRACT_BOUNDS.rows,
    piEvents: CONTRACT_BOUNDS.rows,
    piOriginProjections: CONTRACT_BOUNDS.rows,
    piOriginEvents: CONTRACT_BOUNDS.rows,
    piCommands: CONTRACT_BOUNDS.rows,
    piApiRequests: CONTRACT_BOUNDS.rows,
    workspaceClaims: CONTRACT_BOUNDS.rows,
    workerAttempts: CONTRACT_BOUNDS.rows,
    processFacts: CONTRACT_BOUNDS.rows,
  };
  for (const [key, max] of Object.entries(arrayBounds)) {
    const arr = raw[key];
    if (!Array.isArray(arr) || arr.length > max) throw new Error(`snapshot ${key} invalid or oversized`);
    for (const item of arr) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`snapshot ${key} row invalid`);
      const row = item as Record<string, unknown>;
      for (const v of Object.values(row)) {
        if (typeof v === "string" && v.length > CONTRACT_BOUNDS.evidenceString) throw new Error(`snapshot ${key} row value oversized`);
        if (typeof v === "number" && (Number.isNaN(v) || Math.abs(v) > 1e12)) throw new Error(`snapshot ${key} row number invalid`);
      }
    }
  }
  const leak = rejectEvidenceLeak(raw, "snapshot");
  if (!leak.ok) throw new Error(leak.error);
  return raw as unknown as RemoteSwarmSnapshotV1;
}

function validatePiControlResult(raw: Record<string, unknown>): ValidationResult<RemoteSwarmPiControlResultV1> {
  const allow = rejectUnknownFields(raw, ["version", "role", "runId", "action", "outcome", "error", "projection"]);
  if (!allow.ok) return allow;
  const action = expectString(raw.action, "action", { max: 16 });
  if (!action.ok) return action;
  const outcome = expectString(raw.outcome, "outcome", { max: 32 });
  if (!outcome.ok) return outcome;
  if (raw.error !== null && raw.error !== undefined) {
    const err = expectObject(raw.error);
    if (!err.ok) return err;
    const e = expectString(err.value.code, "error.code", { max: 64 });
    if (!e.ok) return e;
    const m = expectString(err.value.message, "error.message", { max: CONTRACT_BOUNDS.message });
    if (!m.ok) return m;
  }
  if (raw.projection !== null && raw.projection !== undefined) {
    const p = expectObject(raw.projection);
    if (!p.ok) return p;
    for (const [k, v] of Object.entries(p.value)) {
      if (typeof v === "string" && v.length > 512) return fail(`projection.${k} oversized`);
      if (typeof v === "number" && !Number.isInteger(v)) return fail(`projection.${k} invalid`);
      if (v !== null && typeof v !== "string" && typeof v !== "number") return fail(`projection.${k} invalid`);
    }
  }
  const leak = rejectEvidenceLeak(raw, "control");
  if (!leak.ok) return leak;
  return { ok: true, value: raw as unknown as RemoteSwarmPiControlResultV1 };
}

function validateLogTail(raw: Record<string, unknown>): ValidationResult<RemoteSwarmLogTailV1> {
  const allow = rejectUnknownFields(raw, ["version", "role", "runId", "truncated", "tail"]);
  if (!allow.ok) return allow;
  if (typeof raw.truncated !== "boolean") return fail("log-tail truncated invalid");
  if (typeof raw.tail !== "string") return fail("log-tail tail invalid");
  if (raw.tail.length > CONTRACT_BOUNDS.tailBytes) return fail("log-tail oversized");
  const leak = rejectEvidenceLeak(raw, "log-tail");
  if (!leak.ok) return leak;
  return { ok: true, value: raw as unknown as RemoteSwarmLogTailV1 };
}

// ── Result validator ─────────────────────────────────────────────────────────

export function validateLiveResult(raw: unknown): ValidationResult<RemoteSwarmLiveResultV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["version", "runId", "profile", "expectedCommit", "requesterBuild", "receiverBuild", "startedAt", "finishedAt", "state", "scenarios", "cleanup", "failure"]);
  if (!allow.ok) return allow;
  if (obj.value.version !== 1) return fail("unsupported live result version (expected 1)");
  const runId = expectString(obj.value.runId, "runId", { min: 3, max: CONTRACT_BOUNDS.runId });
  if (!runId.ok) return runId;
  const profile = expectString(obj.value.profile, "profile", { max: 16 });
  if (!profile.ok) return profile;
  if (profile.value !== "foundation" && profile.value !== "full") return fail("profile must be foundation or full");
  const state = expectString(obj.value.state, "state", { max: 16 });
  if (!state.ok) return state;
  if (!["passed", "failed", "blocked"].includes(state.value)) return fail("state must be passed, failed, or blocked");
  const expectedCommit = expectString(obj.value.expectedCommit, "expectedCommit", { min: 4, max: 64 });
  if (!expectedCommit.ok) return expectedCommit;
  const requesterBuild = expectString(obj.value.requesterBuild, "requesterBuild", { min: 0, max: 64 });
  if (!requesterBuild.ok) return requesterBuild;
  const receiverBuild = expectString(obj.value.receiverBuild, "receiverBuild", { min: 0, max: 64 });
  if (!receiverBuild.ok) return receiverBuild;
  const startedAt = expectString(obj.value.startedAt, "startedAt", { min: 1, max: 64 });
  if (!startedAt.ok) return startedAt;
  const finishedAt = expectString(obj.value.finishedAt, "finishedAt", { min: 1, max: 64 });
  if (!finishedAt.ok) return finishedAt;
  if (!Array.isArray(obj.value.scenarios) || obj.value.scenarios.length === 0 || obj.value.scenarios.length > 16) {
    return fail("scenarios must be a non-empty array of at most 16");
  }
  const scenarios: RemoteSwarmScenarioResultV1[] = [];
  for (const s of obj.value.scenarios) {
    const sv = validateScenario(s);
    if (!sv.ok) return sv;
    scenarios.push(sv.value);
  }
  const cleanupObj = expectObject(obj.value.cleanup);
  if (!cleanupObj.ok) return cleanupObj;
  if (!["passed", "failed", "blocked"].includes(String(cleanupObj.value.state))) return fail("cleanup.state invalid");
  if (!Array.isArray(cleanupObj.value.assertions) || cleanupObj.value.assertions.length > 32) return fail("cleanup.assertions invalid");
  const assertions: RemoteSwarmCleanupAssertionV1[] = [];
  for (const a of cleanupObj.value.assertions) {
    const aObj = expectObject(a);
    if (!aObj.ok) return aObj;
    if (typeof aObj.value.id !== "string" || aObj.value.id.length > 128) return fail("cleanup assertion id invalid");
    if (typeof aObj.value.passed !== "boolean") return fail("cleanup assertion passed invalid");
    if (typeof aObj.value.detail !== "string" || aObj.value.detail.length > CONTRACT_BOUNDS.message) return fail("cleanup assertion detail invalid");
    assertions.push({ id: aObj.value.id, passed: aObj.value.passed, detail: aObj.value.detail });
  }
  if (obj.value.failure !== null && obj.value.failure !== undefined) {
    const f = expectObject(obj.value.failure);
    if (!f.ok) return f;
    for (const [k, v] of Object.entries(f.value)) {
      if (typeof v !== "string" || v.length > CONTRACT_BOUNDS.message) return fail(`failure.${k} invalid`);
    }
  }
  const leak = rejectEvidenceLeak(obj.value, "result");
  if (!leak.ok) return leak;
  return {
    ok: true,
    value: {
      version: 1,
      runId: runId.value,
      profile: profile.value as RemoteSwarmProfileName,
      expectedCommit: expectedCommit.value,
      requesterBuild: String(obj.value.requesterBuild),
      receiverBuild: String(obj.value.receiverBuild),
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      state: state.value as RemoteSwarmLiveResultV1["state"],
      scenarios,
      cleanup: { state: cleanupObj.value.state as RemoteSwarmCleanupResultV1["state"], assertions },
      failure: obj.value.failure === null || obj.value.failure === undefined
        ? null
        : { stage: String((obj.value.failure as Record<string, unknown>).stage), code: String((obj.value.failure as Record<string, unknown>).code), message: String((obj.value.failure as Record<string, unknown>).message) },
    },
  };
}

function validateScenario(raw: unknown): ValidationResult<RemoteSwarmScenarioResultV1> {
  const obj = expectObject(raw);
  if (!obj.ok) return obj;
  const allow = rejectUnknownFields(obj.value, ["id", "name", "state", "startedAt", "finishedAt", "durationMs", "failure", "evidence"]);
  if (!allow.ok) return allow;
  const id = expectString(obj.value.id, "id", { min: 1, max: 64, pattern: /^[A-Za-z0-9._:-]+$/ });
  if (!id.ok) return id;
  const name = expectString(obj.value.name, "name", { min: 1, max: 128 });
  if (!name.ok) return name;
  const state = expectString(obj.value.state, "state", { max: 16 });
  if (!state.ok) return state;
  if (!["passed", "failed", "blocked"].includes(state.value)) return fail("scenario state invalid");
  const startedAt = expectString(obj.value.startedAt, "startedAt", { min: 1, max: 64 });
  if (!startedAt.ok) return startedAt;
  const finishedAt = expectString(obj.value.finishedAt, "finishedAt", { min: 1, max: 64 });
  if (!finishedAt.ok) return finishedAt;
  const durationMs = expectNumber(obj.value.durationMs, "durationMs", { min: 0, max: 24 * 3600 * 1000, int: true });
  if (!durationMs.ok) return durationMs;
  let failure: RemoteSwarmScenarioResultV1["failure"] = null;
  if (obj.value.failure !== null && obj.value.failure !== undefined) {
    const f = expectObject(obj.value.failure);
    if (!f.ok) return f;
    const fAllow = rejectUnknownFields(f.value, ["stage", "code", "message"]);
    if (!fAllow.ok) return fAllow;
    const stage = expectString(f.value.stage, "failure.stage", { max: 64 });
    if (!stage.ok) return stage;
    const code = expectString(f.value.code, "failure.code", { max: 64 });
    if (!code.ok) return code;
    const message = expectString(f.value.message, "failure.message", { max: CONTRACT_BOUNDS.message });
    if (!message.ok) return message;
    failure = { stage: stage.value, code: code.value, message: message.value };
  }
  const evidence: Array<{ kind: string; id: string }> = [];
  if (obj.value.evidence !== undefined) {
    if (!Array.isArray(obj.value.evidence) || obj.value.evidence.length > 32) return fail("scenario evidence invalid");
    for (const e of obj.value.evidence) {
      const eObj = expectObject(e);
      if (!eObj.ok) return eObj;
      const kind = expectString(eObj.value.kind, "evidence.kind", { max: 32 });
      if (!kind.ok) return kind;
      const id = expectString(eObj.value.id, "evidence.id", { min: 1, max: 128 });
      if (!id.ok) return id;
      evidence.push({ kind: kind.value, id: id.value });
    }
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      state: state.value as RemoteSwarmScenarioResultV1["state"],
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      durationMs: durationMs.value,
      failure,
      evidence,
    },
  };
}

/** Marker text embedded in every live goal: [testing, remote-swarm-e2e:<runId>] */
export function runMarker(runId: string): string {
  return `[${REMOTE_SWARM_MARKER_PREFIX}${runId}]`;
}

/** Validate a runId for use in goals/request IDs. */
export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(runId);
}
