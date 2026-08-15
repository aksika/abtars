/**
 * remote-swarm-live-e2e.test.ts — #1624 focused tests for the live two-node
 * swarm acceptance driver.
 *
 * Covers contracts/validation, argument safety, command ports (local + tmux
 * against a fake tmux binary), the real probe against fixture databases, and
 * the controller state machine with scripted node ports. These tests never
 * touch a live bridge, another host, or a real peer route.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  validateProfile,
  validateNodeCommand,
  validateNodeResult,
  validateLiveResult,
  runMarker,
  looksSecretValue,
  isSafeArgvToken,
  type RemoteSwarmLiveProfileV1,
  type RemoteSwarmNodeResultV1,
  type RemoteSwarmSnapshotV1,
  type RemoteSwarmNodePreflightV1,
} from "./remote-swarm-live-contracts.ts";
import {
  parseControllerArgs,
  buildRunId,
  quoteArg,
  LocalCommandPort,
  TmuxCommandPort,
  parseProbeOutput,
  ProbeClient,
  EvidenceWriter,
  runRemoteSwarmLiveE2E,
  runFull,
  newTrackedObjects,
  pollUntil,
  buildResumeApproval,
  type CommandPort,
  type HttpDelegatePort,
  type DelegateResponse,
  type OrcCallResult,
  type OrcCallPort,
} from "./remote-swarm-live-e2e.ts";

const repoRoot = resolve(__dirname, "..");
const probeScript = join(repoRoot, "scripts", "remote-swarm-live-node.ts");

function tmpdirFixture(): string {
  return mkdtempSync(join(tmpdir(), "rs-live-"));
}

function makeProfile(overrides: Partial<RemoteSwarmLiveProfileV1> = {}, root = tmpdirFixture()): { root: string; profile: RemoteSwarmLiveProfileV1 } {
  const requester = {
    role: "requester" as const,
    workdir: root,
    abtarsHome: root,
    exec: { kind: "local" as const },
    node: process.execPath,
    agentApiPort: 17100,
  };
  const receiver = {
    role: "receiver" as const,
    workdir: root,
    abtarsHome: root,
    exec: { kind: "tmux" as const, session: "rs-test" },
    node: process.execPath,
    agentApiPort: 17101,
  };
  const profile: RemoteSwarmLiveProfileV1 = {
    version: 1,
    requester,
    receiver,
    receiverPeerName: "peer-r",
    requesterPeerName: "peer-q",
    receiverWorkspaceAlias: "e2e-disposable",
    evidenceRoot: join(root, "evidence"),
    ...overrides,
  };
  return { root, profile };
}

function writeFixture(root: string, name: string, content: string): void {
  mkdirSync(join(root, name.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(root, name), content);
}

function preflightFixture(role: "requester" | "receiver", runId: string, opts: Partial<RemoteSwarmNodePreflightV1> = {}): RemoteSwarmNodePreflightV1 {
  return {
    version: 1,
    role,
    runId,
    probeSchemaVersion: 1,
    nodeVersion: "22.19.0",
    build: { manifestPresent: true, commit: "abc123def456", branch: "dev", version: "0.4.1-alpha.0", source: "dev", matchesExpected: true },
    bridge: { running: true, pid: 4242, startedAt: "2026-08-15T00:00:00.000Z", heartbeatFresh: true, startIdentity: "4242:123", sleepStatus: "awake" },
    peerApi: { state: "listening", port: 7100, runtimeSnapshotPresent: true },
    route: { expectedPeerRoute: true, authenticated: true, direction: "accepted", connectedAt: "2026-08-15T00:00:00.000Z", otherRoutes: 0 },
    enrollment: { selfEnrolled: true, peersCount: 1 },
    capabilities: { piExecutorConfigured: true, workspaceAliasPresent: true },
    credentials: { transportJson: true, modelsJson: true, usersJson: true, providerSecretPresent: true, identityKeyPresent: true, peersJson: true },
    ...opts,
  };
}

const HASH = "a".repeat(64);

interface FixtureRows {
  requestIds: string[];
  receiverCards?: number;
  requesterProxyCards?: number;
  requesterRootCards?: number;
  contributionState?: string;
  helpState?: string;
  declinedRequestId?: string;
  inboundRequestId?: string;
  piRun?: { runId: string; status: string };
}

function emptySnapshot(role: "requester" | "receiver", runId: string, requestIds: string[]): RemoteSwarmSnapshotV1 {
  return {
    version: 1, role, runId, at: "2026-08-15T00:00:00.000Z", requestIds,
    cards: [], contributions: [], contributionEvents: [], helpRequests: [],
    supervisions: [], reviewCases: [], reviewDecisions: [], acceptanceOutbox: [],
    piRuns: [], piEvents: [], piOriginProjections: [], piOriginEvents: [],
    piCommands: [], piApiRequests: [], workspaceClaims: [], workerAttempts: [], processFacts: [],
  };
}

function snapshotFixture(role: "requester" | "receiver", runId: string, rows: FixtureRows): RemoteSwarmSnapshotV1 {
  const base = emptySnapshot(role, runId, rows.requestIds);
  const acceptedRequestId = rows.requestIds[0] ?? `swarm-${runId}-f1-accepted`;
  const receiverCardId = 101;
  const proxyCardId = 202;
  const rootCardId = 303;
  const eventId = `accept_${acceptedRequestId}_help_abcd1234_rd_1`;
  const marker = runMarker(runId);

  if (role === "requester") {
    base.contributions = [
      {
        requestId: acceptedRequestId,
        contributionRef: "help_abcd1234",
        requestHash: HASH,
        state: rows.contributionState ?? "completed",
        lastSequence: 0,
        terminalEventId: eventId,
        terminalDigest: HASH,
        projection: { outcome: "completed", receiverProjectRef: "project_101", acceptanceId: "rd_1", acceptedAt: "2026-08-15T00:00:00.000Z" },
      },
    ];
    if (rows.declinedRequestId) {
      base.contributions.push({
        requestId: rows.declinedRequestId,
        contributionRef: "help_deadbeef",
        requestHash: HASH,
        state: "declined",
        lastSequence: -1,
        terminalEventId: null,
        terminalDigest: null,
        projection: null,
      });
    }
    base.contributionEvents = [
      { eventId, requestId: acceptedRequestId, contributionRef: "help_abcd1234", sequence: 0, kind: "completed", payloadDigest: HASH },
    ];
    base.cards = [];
    for (let i = 0; i < (rows.requesterProxyCards ?? 1); i++) {
      base.cards.push({
        id: proxyCardId + i, type: "contribution", status: "delivered", source: "peer", sourceId: acceptedRequestId,
        parentId: rootCardId, deliveryMode: "silent", deliveryResult: "sent", resultSummary: null,
        markerPresent: true, notesRequestId: acceptedRequestId, notesContributionRef: "help_abcd1234",
        notesOutcome: "completed", notesRemoteRunId: rows.piRun?.runId ?? null, notesHelpDecision: null,
      });
    }
    for (let i = 0; i < (rows.requesterRootCards ?? 1); i++) {
      base.cards.push({
        id: rootCardId + i, type: "O", status: "delivered", source: "cli", sourceId: acceptedRequestId,
        parentId: null, deliveryMode: "silent", deliveryResult: "sent", resultSummary: "accepted",
        markerPresent: true, notesRequestId: acceptedRequestId, notesContributionRef: null,
        notesOutcome: null, notesRemoteRunId: null, notesHelpDecision: null,
      });
    }
    base.supervisions = [{ projectCardId: rootCardId, state: "accepted", generation: 1, reviewRound: 1, activeReviewCaseId: null, acceptedDecisionId: "rd_req_1", blockedReason: null }];
    if (rows.inboundRequestId) {
      base.helpRequests = [{
        requestId: rows.inboundRequestId, contributionRef: "help_12345678", state: "accepted", localCardId: 404,
        localRunId: null, responseDecision: "accepted", reasonCode: null, provesNonCreation: false, requestHash: HASH,
      }];
      base.cards.push({
        id: 404, type: "O", status: "delivered", source: "peer", sourceId: rows.inboundRequestId,
        parentId: null, deliveryMode: "silent", deliveryResult: "sent", resultSummary: null,
        markerPresent: true, notesRequestId: rows.inboundRequestId, notesContributionRef: null,
        notesOutcome: null, notesRemoteRunId: null, notesHelpDecision: "accepted",
      });
    }
    if (rows.piRun) {
      base.piOriginProjections = [{
        runId: rows.piRun.runId, originRequestId: acceptedRequestId, latestSequence: 5, acknowledgedSequence: 5,
        latestGeneration: 1, latestStatus: rows.piRun.status, resumeCapability: null,
        pendingInputPresent: false, resultSummary: null, errorSummary: null,
      }];
      base.piOriginEvents = [
        { runId: rows.piRun.runId, sequence: 1, kind: "origin-event", generation: 0, acknowledgedAt: null, eventId: `evt_${rows.piRun.runId}_1` },
      ];
    }
  } else {
    base.helpRequests = [{
      requestId: acceptedRequestId, contributionRef: "help_abcd1234", state: rows.helpState ?? "accepted",
      localCardId: receiverCardId, localRunId: null, responseDecision: "accepted", reasonCode: null,
      provesNonCreation: false, requestHash: HASH,
    }];
    if (rows.declinedRequestId) {
      base.helpRequests.push({
        requestId: rows.declinedRequestId, contributionRef: null, state: "declined", localCardId: null,
        localRunId: null, responseDecision: "declined", reasonCode: "policy_denied",
        provesNonCreation: true, requestHash: HASH,
      });
    }
    base.cards = [];
    for (let i = 0; i < (rows.receiverCards ?? 1); i++) {
      base.cards.push({
        id: receiverCardId + i, type: "O", status: "delivered", source: "peer", sourceId: acceptedRequestId,
        parentId: null, deliveryMode: "silent", deliveryResult: "sent", resultSummary: "accepted",
        markerPresent: true, notesRequestId: acceptedRequestId, notesContributionRef: "help_abcd1234",
        notesOutcome: "accepted", notesRemoteRunId: null, notesHelpDecision: "accepted",
      });
    }
    base.supervisions = [{ projectCardId: receiverCardId, state: "accepted", generation: 1, reviewRound: 1, activeReviewCaseId: null, acceptedDecisionId: "rd_1", blockedReason: null }];
    base.reviewCases = [{ id: "rc_101_1_1", projectCardId: receiverCardId, generation: 1, round: 1, status: "accepted", snapshotDigest: HASH }];
    base.reviewDecisions = [{ id: "rd_1", reviewCaseId: "rc_101_1_1", projectCardId: receiverCardId, action: "accept" }];
    base.acceptanceOutbox = [{ id: "ao_rd_1", projectCardId: receiverCardId, attempts: 1, sentAt: "2026-08-15T00:00:00.000Z", lastError: null }];
    if (rows.piRun) {
      base.piRuns = [{
        runId: rows.piRun.runId, cardId: 505, status: rows.piRun.status, generation: 1,
        originRequestId: acceptedRequestId, workspaceAlias: "e2e-disposable",
        resumeCapability: "available", generationIntent: "initial",
      }];
      base.processFacts = [{
        runId: rows.piRun.runId, observedPidPresent: rows.piRun.status === "running",
        sessionPresent: false, resumeCapability: "available", generationIntent: "initial",
      }];
      base.piEvents = [
        { runId: rows.piRun.runId, sequence: 1, kind: "accepted", generation: 1, acknowledgedAt: "2026-08-15T00:00:00.000Z", eventId: null },
        { runId: rows.piRun.runId, sequence: 2, kind: "running", generation: 1, acknowledgedAt: "2026-08-15T00:00:00.000Z", eventId: null },
        { runId: rows.piRun.runId, sequence: 3, kind: rows.piRun.status === "cancelled" ? "cancelled" : "running", generation: 1, acknowledgedAt: "2026-08-15T00:00:00.000Z", eventId: null },
      ];
      base.piCommands = [
        { commandId: "rs-cancel-x", runId: rows.piRun.runId, state: "completed", payloadHash: HASH },
      ];
      if (rows.piRun.status !== "cancelled") {
        base.workspaceClaims = [{ runId: rows.piRun.runId, generation: 1, ownerKind: "standalone" }];
      }
    }
  }
  return base;
}

function writeSnapshotFixture(root: string, role: "requester" | "receiver", runId: string, rows: FixtureRows): void {
  const snap = snapshotFixture(role, runId, rows);
  writeFileSync(join(root, `${role}-snapshot-full.json`), `REMOTE_SWARM_NODE_RESULT=${JSON.stringify({ kind: "snapshot", value: snap })}\n`);
  const empty = emptySnapshot(role, runId, []);
  writeFileSync(join(root, `${role}-snapshot-empty.json`), `REMOTE_SWARM_NODE_RESULT=${JSON.stringify({ kind: "snapshot", value: empty })}\n`);
}

function writePreflightFixture(root: string, role: "requester" | "receiver", runId: string, opts: Partial<RemoteSwarmNodePreflightV1> = {}): void {
  const preflight = preflightFixture(role, runId, opts);
  writeFileSync(join(root, `${role}-preflight.json`), `REMOTE_SWARM_NODE_RESULT=${JSON.stringify({ kind: "preflight", value: preflight })}\n`);
}

function writeFakeNode(dir: string): string {
  const fake = join(dir, "fake-node.sh");
  const lines = [
    "#!/usr/bin/env bash",
    "set -u",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'CMD=""',
    'ROLE=""',
    'JSON=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --command) CMD="$2"; shift 2 ;;',
    '    --role) ROLE="$2"; shift 2 ;;',
    '    --json) JSON="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'FILE="$DIR/$ROLE-$CMD.json"',
    'if [ "$CMD" = "snapshot" ]; then',
    '  SUFFIX="-full.json"',
    '  if [ -n "$JSON" ]; then',
    '    DECODED=$(echo "$JSON" | tr "_-" "/+" | base64 -d 2>/dev/null)',
    '    if echo "$DECODED" | grep -Fq \'"requestIds":[]\' ; then',
    '      SUFFIX="-empty.json"',
    '    fi',
    '  fi',
    '  FILE="$DIR/$ROLE-$CMD$SUFFIX"',
    'fi',
    'if [ -f "$FILE" ]; then',
    '  cat "$FILE"',
    '  exit 0',
    'fi',
    'echo "REMOTE_SWARM_NODE_ERROR={\\"code\\":\\"NO_FAKE\\",\\"message\\":\\"no fixture for $ROLE-$CMD${SUFFIX:-}\\"}" >&2',
    'exit 1',
  ];
  writeFileSync(fake, lines.join("\n") + "\n");
  chmodSync(fake, 0o755);
  return fake;
}

function writeFakeTmux(root: string): string {
  const fake = join(root, "fake-tmux.sh");
  const lines = [
    "#!/usr/bin/env bash",
    "set -u",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'STATE="${FAKE_TMUX_STATE:-$DIR/tmux-state.txt}"',
    'OP="$1"',
    'if [ "$OP" = "send-keys" ]; then',
    "  shift",
    "  shift 2",
    '  text="$1"',
    "  {",
    '    echo "LINE:$text"',
    '    cd "${FAKE_TMUX_CWD:-/}" 2>/dev/null',
    '    sh -c "$text" 2>&1',
    "  } >> \"$STATE\"",
    'elif [ "$OP" = "capture-pane" ]; then',
    '  if [ -f "$STATE" ]; then cat "$STATE"; fi',
    "fi",
  ];
  writeFileSync(fake, lines.join("\n") + "\n");
  chmodSync(fake, 0o755);
  return fake;
}

function makeFakePorts(root: string, runId: string): { requesterPort: CommandPort; receiverPort: CommandPort; fakeNodeDir: string; tmuxState: string; tmuxBin: string; fakeNode: string } {
  const fakeNodeDir = join(root, "fixtures");
  mkdirSync(fakeNodeDir, { recursive: true });
  const fakeNode = writeFakeNode(fakeNodeDir);
  const tmuxState = join(root, "tmux-state.txt");
  const tmuxBin = writeFakeTmux(root);
  writePreflightFixture(fakeNodeDir, "requester", runId);
  writePreflightFixture(fakeNodeDir, "receiver", runId);
  const requesterPort = new LocalCommandPort();
  const receiverPort = new TmuxCommandPort({ session: "rs-test", pollMs: 40, tmuxBin });
  return { requesterPort, receiverPort, fakeNodeDir, tmuxState, tmuxBin, fakeNode };
}

function profileWithFakeNode(root: string, fakeNode: string): { root: string; profile: RemoteSwarmLiveProfileV1 } {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    profile: {
      version: 1,
      requester: { role: "requester", workdir: home, abtarsHome: home, exec: { kind: "local" }, node: fakeNode, agentApiPort: 17100 },
      receiver: { role: "receiver", workdir: home, abtarsHome: home, exec: { kind: "tmux", session: "rs-test" }, node: fakeNode, agentApiPort: 17101 },
      receiverPeerName: "peer-r",
      receiverWorkspaceAlias: "e2e-disposable",
      evidenceRoot: join(root, "evidence"),
    },
  };
}

function makeStatefulDelegate(acceptedRef: string, acceptedRoot: number, acceptedProxy: number): HttpDelegatePort {
  const handler: HttpDelegatePort = async (body) => {
    const response: DelegateResponse = {
      ok: true,
      decision: "accepted",
      projectCardId: acceptedRoot,
      proxyCardId: acceptedProxy,
      requestId: body.request_id,
      contributionRef: acceptedRef,
    };
    return response;
  };
  return handler;
}

const fastSleep = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); };

// ── Contracts ────────────────────────────────────────────────────────────────

describe("contracts: profile validation", () => {
  it("accepts a valid profile", () => {
    const { profile } = makeProfile();
    const result = validateProfile(profile);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.receiverWorkspaceAlias).toBe("e2e-disposable");
  });

  it("rejects relative and root workdirs", () => {
    const { root, profile } = makeProfile();
    const relative = { ...profile, requester: { ...profile.requester, workdir: "relative/path" } };
    expect(validateProfile(relative).ok).toBe(false);
    const rootDir = { ...profile, receiver: { ...profile.receiver, workdir: "/" } };
    expect(validateProfile(rootDir).ok).toBe(false);
    const rootHome = { ...profile, receiver: { ...profile.receiver, workdir: "/root" } };
    expect(validateProfile(rootHome).ok).toBe(false);
    expect(validateProfile({ ...profile, evidenceRoot: "relative" }).ok).toBe(false);
  });

  it("rejects unknown fields and bad versions", () => {
    const { root, profile } = makeProfile();
    const badVersion = { ...profile, version: 2 };
    expect(validateProfile(badVersion).ok).toBe(false);
    const unknown = { ...profile, extra: 1 };
    expect(validateProfile(unknown).ok).toBe(false);
    const unknownNode = { ...profile, requester: { ...profile.requester, sneaky: 1 } };
    expect(validateProfile(unknownNode).ok).toBe(false);
  });

  it("rejects role mismatches and unsafe node tokens", () => {
    const { root, profile } = makeProfile();
    const wrongRole = { ...profile, receiver: { ...profile.receiver, role: "requester" } };
    expect(validateProfile(wrongRole).ok).toBe(false);
    const unsafeNode = { ...profile, requester: { ...profile.requester, node: "node;rm -rf /" } };
    expect(validateProfile(unsafeNode).ok).toBe(false);
    const badAlias = { ...profile, receiverWorkspaceAlias: "UPPER-CASE" };
    expect(validateProfile(badAlias).ok).toBe(false);
    const badSession = { ...profile, receiver: { ...profile.receiver, exec: { kind: "tmux", session: "a b" } } };
    expect(validateProfile(badSession).ok).toBe(false);
  });
});

describe("contracts: node command validation", () => {
  it("rejects remote-pi-control on the receiver and unknown commands", () => {
    expect(validateNodeCommand({ version: 1, role: "receiver", runId: "rs-1", command: "remote-pi-control", pi: { action: "status", piRunId: "r", generation: 1, commandId: "c" } }).ok).toBe(false);
    expect(validateNodeCommand({ version: 1, role: "requester", runId: "rs-1", command: "nuke" }).ok).toBe(false);
  });

  it("rejects unbounded request ids and arrays", () => {
    const longId = "x".repeat(200);
    expect(validateNodeCommand({ version: 1, role: "requester", runId: "rs-1", command: "snapshot", requestIds: [longId] }).ok).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => `id-${i}`);
    expect(validateNodeCommand({ version: 1, role: "requester", runId: "rs-1", command: "snapshot", requestIds: many }).ok).toBe(false);
  });

  it("rejects secret-shaped or pathological pi values", () => {
    const bigValue = { version: 1, role: "requester", runId: "rs-1", command: "remote-pi-control", pi: { action: "reply", piRunId: "r", generation: 1, commandId: "c", requestId: "q", value: "y".repeat(20_000) } };
    expect(validateNodeCommand(bigValue).ok).toBe(false);
  });
});

describe("contracts: node result validation", () => {
  it("rejects a snapshot whose role or run id does not match the command", () => {
    const runId = "rs-role-test";
    const snap = snapshotFixture("requester", runId, { requestIds: ["a"] });
    const wrongRole = { kind: "snapshot", value: { ...snap, role: "receiver" } };
    expect(validateNodeResult(wrongRole, "requester", runId).ok).toBe(false);
    const wrongRun = { kind: "snapshot", value: { ...snap, runId: "rs-other" } };
    expect(validateNodeResult(wrongRun, "requester", runId).ok).toBe(false);
    expect(validateNodeResult({ kind: "snapshot", value: snap }, "requester", runId).ok).toBe(true);
  });

  it("rejects secret-shaped values and absolute paths in evidence", () => {
    const runId = "rs-leak-test";
    const snap = snapshotFixture("requester", runId, { requestIds: ["a"] });
    const withSecret = { ...snap, contributions: [{ ...snap.contributions[0]!, requestHash: "sk-abcdefghijklmnopqrstuvwxyz1234" }] };
    expect(() => validateNodeResult({ kind: "snapshot", value: withSecret }, "requester", runId)).toThrow(/secret-shaped/);
    const withPath = { ...snap, at: "/home/user/secret-path" };
    expect(() => validateNodeResult({ kind: "snapshot", value: withPath }, "requester", runId)).toThrow(/absolute path/);
  });

  it("rejects oversized evidence arrays", () => {
    const runId = "rs-size-test";
    const snap = snapshotFixture("requester", runId, { requestIds: ["a"] });
    const oversized = { ...snap, cards: Array.from({ length: 60 }, (_, i) => snap.cards[0] ? { ...snap.cards[0], id: i + 1 } : null) };
    expect(() => validateNodeResult({ kind: "snapshot", value: oversized }, "requester", runId)).toThrow(/oversized/);
  });

  it("recognizes secret-shaped values", () => {
    expect(looksSecretValue("sk-abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
    expect(looksSecretValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksSecretValue("help_abcd1234")).toBe(false);
    expect(looksSecretValue(HASH)).toBe(false);
    expect(looksSecretValue("ZW5jcnlwdGVkLXZhbHVlLWxvbmctYmFzZTY0LXBhZGRpbmc=")).toBe(true);
  });
});

describe("contracts: live result validation", () => {
  it("rejects a passed result that is missing scenarios or cleanup", () => {
    const bad = { version: 1, runId: "rs-1", profile: "foundation", expectedCommit: "abc", requesterBuild: "", receiverBuild: "", startedAt: "t", finishedAt: "t", state: "passed", scenarios: [], cleanup: { state: "passed", assertions: [] }, failure: null };
    expect(validateLiveResult(bad).ok).toBe(false);
    const missingCleanup = { ...bad, scenarios: [{ id: "s", name: "s", state: "passed", startedAt: "t", finishedAt: "t", durationMs: 1, failure: null, evidence: [] }] };
    expect(validateLiveResult(missingCleanup).ok).toBe(false);
  });

  it("rejects a result with an unknown scenario state", () => {
    const result = {
      version: 1, runId: "rs-1", profile: "foundation", expectedCommit: "abc", requesterBuild: "", receiverBuild: "",
      startedAt: "t", finishedAt: "t", state: "passed",
      scenarios: [{ id: "s", name: "s", state: "banana", startedAt: "t", finishedAt: "t", durationMs: 1, failure: null, evidence: [] }],
      cleanup: { state: "passed", assertions: [] },
      failure: null,
    };
    expect(validateLiveResult(result).ok).toBe(false);
  });
});

// ── Argument safety ──────────────────────────────────────────────────────────

describe("argument safety", () => {
  it("quotes and escapes shell metacharacters without injection", () => {
    expect(quoteArg("plain")).toBe("'plain'");
    expect(quoteArg("a'b")).toBe("'a'\\''b'");
  });

  it("accepts only safe bare tokens", () => {
    expect(isSafeArgvToken("node")).toBe(true);
    expect(isSafeArgvToken("/home/user/workdir")).toBe(true);
    expect(isSafeArgvToken("scripts/remote-swarm-live-node.ts")).toBe(true);
    expect(isSafeArgvToken("a;b")).toBe(false);
    expect(isSafeArgvToken("$(x)")).toBe(false);
    expect(isSafeArgvToken("a b")).toBe(false);
    expect(isSafeArgvToken("")).toBe(false);
  });

  it("parses controller args strictly", () => {
    const args = parseControllerArgs(["--profile", "foundation", "--profile-file", "/tmp/p.json", "--expected-commit", "abc123", "--allow-restarts"]);
    expect(args.profile).toBe("foundation");
    expect(args.allowRestarts).toBe(true);
    expect(args.allowResume).toBe(false);
    expect(() => parseControllerArgs(["--profile", "full"])).toThrow();
    expect(() => parseControllerArgs(["--profile", "foundation", "--profile-file", "relative.json", "--expected-commit", "abc"])).toThrow();
    expect(() => parseControllerArgs(["--bogus"])).toThrow();
  });
});

// ── Command ports ────────────────────────────────────────────────────────────

describe("local command port", () => {
  it("executes argv safely and bounds output", async () => {
    const port = new LocalCommandPort();
    const result = await port.run([{ text: process.execPath, quote: false }, { text: "-e", quote: false }, { text: "console.log('hello')", quote: true }], { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("rejects unsafe argv", async () => {
    const port = new LocalCommandPort();
    await expect(port.run([{ text: process.execPath, quote: false }, { text: "-e; rm -rf /", quote: false }], { timeoutMs: 1_000 })).rejects.toThrow(/unsafe/);
  });

  it("times out and reports it", async () => {
    const port = new LocalCommandPort();
    const result = await port.run([{ text: process.execPath, quote: false }, { text: "-e", quote: false }, { text: "setTimeout(() => {}, 60000)", quote: true }], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe("tmux command port", () => {
  it("runs a command through a fake tmux and extracts the marker body", async () => {
    const root = tmpdirFixture();
    const tmuxBin = writeFakeTmux(root);
    const state = join(root, "state.txt");
    const port = new TmuxCommandPort({ session: "rs-test", pollMs: 30, tmuxBin });
    const result = await port.run([
      { text: "echo", quote: false },
      { text: "hello-from-tmux", quote: false },
    ], { timeoutMs: 10_000, cwd: root });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello-from-tmux");
  });

  it("does not shell-inject quoted content", async () => {
    const root = tmpdirFixture();
    const tmuxBin = writeFakeTmux(root);
    const state = join(root, "state.txt");
    const marker = `pwned-${randomUUID()}`;
    const port = new TmuxCommandPort({ session: "rs-test", pollMs: 30, tmuxBin });
    const result = await port.run([
      { text: `'; touch ${join(tmpdir(), marker)}; echo '`, quote: true },
      { text: "echo", quote: false },
    ], { timeoutMs: 10_000, cwd: root });
    expect(result.ok).toBe(true);
    expect(existsSync(join(tmpdir(), marker))).toBe(false);
    expect(result.stdout).toMatch(/not found/);
  });

  it("times out when the marker never completes", async () => {
    const root = tmpdirFixture();
    const fake = join(root, "fake-tmux-silent.sh");
    const lines = [
      "#!/usr/bin/env bash",
      "set -u",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'STATE="${FAKE_TMUX_STATE:-$DIR/tmux-state.txt}"',
      'if [ "$1" = "send-keys" ]; then',
      '  echo "$4" >> "$STATE"',
      "fi",
    ];
    writeFileSync(fake, lines.join("\n") + "\n");
    chmodSync(fake, 0o755);
    const port = new TmuxCommandPort({ session: "rs-test", pollMs: 20, tmuxBin: fake });
    const result = await port.run([{ text: "sleep", quote: false }, { text: "5", quote: false }], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("rejects an overlapping command", async () => {
    const root = tmpdirFixture();
    const tmuxBin = writeFakeTmux(root);
    const port = new TmuxCommandPort({ session: "rs-test", pollMs: 50, tmuxBin });
    const first = port.run([{ text: "sleep", quote: false }, { text: "1", quote: false }], { timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 150));
    const second = await port.run([{ text: "echo", quote: false }, { text: "x", quote: false }], { timeoutMs: 1_000 });
    expect(second.ok).toBe(false);
    expect(second.stderr).toContain("in flight");
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });
});

// ── Real probe against fixture databases ─────────────────────────────────────

describe("real probe (node type-stripped) against fixture state", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = tmpdirFixture();
    home = join(root, "home");
    mkdirSync(join(home, "kanban"), { recursive: true });
    mkdirSync(join(home, "config"), { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(home, "secret"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runProbe(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [probeScript, ...args], { encoding: "utf-8", timeout: 60_000 });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("reports preflight facts from fixture runtime files", () => {
    writeFileSync(join(home, "manifest.json"), JSON.stringify({ package: "abtars", version: "0.4.1-alpha.0", commit: "abc123def456", branch: "dev", source: "dev" }));
    writeFileSync(join(home, "bridge.lock"), JSON.stringify({ pid: 1234, startedAt: Date.now() - 1_000, lastHeartbeat: Date.now() - 10_000, startIdentity: "1234:1", sleepStatus: "awake" }));
    writeFileSync(join(home, "state", "runtime-health-v1.json"), JSON.stringify({ schemaVersion: 1, routes: [{ peer: "peer-r", authenticated: true, directions: ["accepted"], connectedAt: "2026-08-15T00:00:00.000Z" }] }));
    writeFileSync(join(home, "config", "peers.json"), JSON.stringify({ self: { name: "kp", signingKey: "aGVsbG8=" }, peers: { "peer-r": { host: "127.0.0.1", port: 7100, verifyKey: "a2V5" } } }));
    writeFileSync(join(home, "config", "pi-executor.json"), JSON.stringify({ workspaceAliases: { "e2e-disposable": { path: join(home, "ws") } } }));
    writeFileSync(join(home, "config", "transport.json"), JSON.stringify({ providers: { p: { apiKeyEnv: "TEST_PROVIDER_KEY" } } }));
    writeFileSync(join(home, "config", "models.json"), "{}");
    writeFileSync(join(home, "config", "users.json"), "{}");
    writeFileSync(join(home, "config", "identity.tls.key"), "k");
    writeFileSync(join(home, "secret", "TEST_PROVIDER_KEY"), "abc");

    const result = runProbe(["--home", home, "--role", "receiver", "--run-id", "rs-probe-1", "--command", "preflight", "--expected-commit", "abc123", "--peer", "peer-r", "--require-pi-alias", "e2e-disposable", "--json", Buffer.from(JSON.stringify({ version: 1, role: "receiver", runId: "rs-probe-1", command: "preflight", expectedCommit: "abc123", peer: "peer-r", requirePiAlias: "e2e-disposable" })).toString("base64url")]);
    expect(result.status).toBe(0);
    const { result: parsed } = parseProbeOutput(result.stdout);
    expect(parsed).not.toBeNull();
    const validation = validateNodeResult(parsed, "receiver", "rs-probe-1");
    expect(validation.ok).toBe(true);
    if (validation.ok && validation.value.kind === "preflight") {
      const p = validation.value.value;
      expect(p.build.matchesExpected).toBe(true);
      expect(p.bridge.running).toBe(true);
      expect(p.bridge.heartbeatFresh).toBe(true);
      expect(p.route.expectedPeerRoute).toBe(true);
      expect(p.route.authenticated).toBe(true);
      expect(p.capabilities.workspaceAliasPresent).toBe(true);
      expect(p.credentials.transportJson).toBe(true);
      expect(p.enrollment.selfEnrolled).toBe(true);
      expect(JSON.stringify(p)).not.toContain("peer-r");
      expect(JSON.stringify(p)).not.toContain(home);
    }
  });

  it("snapshots exact-run rows from a fixture kanban.db", () => {
    const db = new DatabaseSync(join(home, "kanban", "kanban.db"));
    const runId = "rs-probe-snap";
    const requestId = `swarm-${runId}-f1-accepted`;
    db.exec(`
      CREATE TABLE kanban_board (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, source TEXT, source_id TEXT, priority TEXT, status TEXT, type TEXT, goal TEXT, notes TEXT, parent_id INTEGER, delivery_mode TEXT, delivery_result TEXT, result_summary TEXT, source_peer TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE peer_contributions (peer TEXT, request_id TEXT, request_hash TEXT, contribution_ref TEXT, project_card_id INTEGER, proxy_card_id INTEGER, root_criteria_json TEXT, state TEXT, last_sequence INTEGER, terminal_event_id TEXT, terminal_digest TEXT, projection_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (peer, request_id));
      CREATE TABLE peer_contribution_events (peer TEXT, event_id TEXT, request_id TEXT, contribution_ref TEXT, sequence INTEGER, payload_digest TEXT, projection_json TEXT, created_at TEXT, PRIMARY KEY (peer, event_id));
      CREATE TABLE peer_help_requests (origin_peer TEXT, request_id TEXT, request_hash TEXT, state TEXT, contribution_ref TEXT UNIQUE, local_card_id INTEGER, local_run_id TEXT, response_json TEXT, withdrawn_at TEXT, PRIMARY KEY (origin_peer, request_id));
      CREATE TABLE project_supervision (project_card_id INTEGER PRIMARY KEY, contract_id TEXT UNIQUE, state TEXT, invalid_contract_proposals INTEGER, generation INTEGER, review_round INTEGER, repair_round INTEGER, active_review_case_id TEXT, accepted_decision_id TEXT, blocked_reason TEXT, updated_at TEXT);
      CREATE TABLE project_review_cases (id TEXT PRIMARY KEY, project_card_id INTEGER, generation INTEGER, round INTEGER, snapshot_digest TEXT, case_json TEXT, status TEXT, created_at TEXT, superseded_at TEXT);
      CREATE TABLE project_review_decisions (id TEXT PRIMARY KEY, review_case_id TEXT UNIQUE, decision_json TEXT, decision_digest TEXT, created_at TEXT);
      CREATE TABLE project_acceptance_outbox (id TEXT PRIMARY KEY, project_card_id INTEGER UNIQUE, peer TEXT, payload_json TEXT, attempts INTEGER, last_error TEXT, created_at TEXT, updated_at TEXT, sent_at TEXT);
      CREATE TABLE pi_runs (id TEXT PRIMARY KEY, card_id INTEGER UNIQUE, status TEXT, execution_generation INTEGER, origin_request_id TEXT, workspace_alias TEXT, resume_capability TEXT, generation_intent TEXT, observed_pid INTEGER, pi_session_file TEXT);
      CREATE TABLE remote_pi_events (run_id TEXT, remote_card_id INTEGER, sequence INTEGER, kind TEXT, generation INTEGER, event_id TEXT UNIQUE, content_sha256 TEXT, origin_peer TEXT, origin_request_id TEXT, projection_json TEXT, occurred_at TEXT, created_at TEXT, acknowledged_at TEXT, PRIMARY KEY (run_id, sequence));
      CREATE TABLE remote_pi_origin_projections (run_id TEXT PRIMARY KEY, remote_card_id INTEGER, origin_request_id TEXT, owner_peer TEXT, latest_sequence INTEGER, acknowledged_sequence INTEGER, latest_generation INTEGER, latest_status TEXT, last_activity_at TEXT, pending_input_json TEXT, result_summary TEXT, error_summary TEXT, usage_json TEXT, changed_files_summary TEXT, resume_capability TEXT, delivery_json TEXT, last_command_outcome_json TEXT, updated_at TEXT);
      CREATE TABLE remote_pi_origin_events (run_id TEXT, sequence INTEGER, event_id TEXT, content_sha256 TEXT, projection_json TEXT, received_at TEXT, PRIMARY KEY (run_id, sequence));
      CREATE TABLE remote_pi_commands (origin_peer TEXT, command_id TEXT, run_id TEXT, payload_hash TEXT, state TEXT, response_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (origin_peer, command_id));
      CREATE TABLE pi_api_requests (client_id TEXT, operation TEXT, request_id TEXT, request_hash TEXT, state TEXT, response_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (client_id, operation, request_id));
      CREATE TABLE pi_workspace_claims (canonical_path TEXT PRIMARY KEY, run_id TEXT, execution_generation INTEGER, owner_kind TEXT, acquired_at TEXT, UNIQUE (run_id, execution_generation));
      CREATE TABLE worker_attempts (id TEXT PRIMARY KEY, card_id INTEGER, contract_id TEXT, ordinal INTEGER, executor_kind TEXT, executor_id TEXT, generation INTEGER, lifecycle TEXT, status TEXT, remote_task_id TEXT, claimed_at TEXT, started_at TEXT, settled_at TEXT, hard_deadline_at TEXT, cancel_reason TEXT, source_attempt_id TEXT, retry_directive_id TEXT, earliest_claim_at TEXT, UNIQUE (card_id, ordinal));
    `);
    const goal = runMarker(runId);
    db.prepare(`INSERT INTO kanban_board (title, source, source_id, status, type, goal, notes, delivery_mode, delivery_result, result_summary, created_at, updated_at) VALUES ('r', 'cli', ?, 'delivered', 'O', ?, '{}', 'silent', 'sent', 'ok', 't', 't')`).run(requestId, goal);
    db.prepare(`INSERT INTO kanban_board (title, source, source_id, status, type, goal, notes, delivery_mode, delivery_result, result_summary, parent_id, source_peer, created_at, updated_at) VALUES ('p', 'peer', ?, 'delivered', 'contribution', ?, ?, 'silent', 'sent', NULL, 1, 'peer-r', 't', 't')`).run(requestId, goal, JSON.stringify({ request_id: requestId, contribution_ref: "help_probe1234", outcome: "completed" }));
    db.prepare(`INSERT INTO peer_contributions (peer, request_id, request_hash, contribution_ref, project_card_id, proxy_card_id, state, last_sequence, terminal_event_id, terminal_digest, projection_json, created_at, updated_at) VALUES ('peer-r', ?, ?, 'help_probe1234', 1, 2, 'completed', 0, 'evt_1', ?, ?, 't', 't')`).run(requestId, HASH, HASH, JSON.stringify({ outcome: "completed", provenance: { receiver_peer: "peer-r", receiver_project_ref: "project_1", acceptance_id: "rd_1", accepted_at: "t" } }));
    db.prepare(`INSERT INTO peer_contribution_events (peer, event_id, request_id, contribution_ref, sequence, payload_digest, projection_json, created_at) VALUES ('peer-r', 'evt_1', ?, 'help_probe1234', 0, ?, ?, 't')`).run(requestId, HASH, JSON.stringify({ kind: "completed" }));
    db.prepare(`INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json) VALUES ('kp', ?, ?, 'accepted', 'help_probe1234', 1, ?)`).run(requestId, HASH, JSON.stringify({ decision: "accepted" }));
    db.prepare(`INSERT INTO project_supervision (project_card_id, state, generation, review_round, accepted_decision_id, updated_at) VALUES (1, 'accepted', 1, 1, 'rd_1', 't')`).run();
    db.prepare(`INSERT INTO project_review_cases (id, project_card_id, generation, round, snapshot_digest, case_json, status, created_at) VALUES ('rc_1', 1, 1, 1, ?, '{}', 'accepted', 't')`).run(HASH);
    db.prepare(`INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at) VALUES ('rd_1', 'rc_1', ?, ?, 't')`).run(JSON.stringify({ action: "accept" }), HASH);
    db.prepare(`INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, attempts, created_at, updated_at, sent_at) VALUES ('ao_1', 1, 'kp', '{}', 1, 't', 't', 't')`).run();
    db.prepare(`INSERT INTO pi_runs (id, card_id, status, execution_generation, origin_request_id, workspace_alias, resume_capability, generation_intent, observed_pid) VALUES ('pi_run_1', 9, 'running', 1, ?, 'e2e-disposable', 'available', 'initial', 7777)`).run(requestId);
    db.prepare(`INSERT INTO remote_pi_events (run_id, remote_card_id, sequence, kind, generation, event_id, content_sha256, origin_peer, origin_request_id, projection_json, occurred_at, created_at, acknowledged_at) VALUES ('pi_run_1', 5, 1, 'accepted', 1, 'evt_pi_1', ?, 'kp', ?, '{}', 't', 't', NULL)`).run(HASH, requestId);
    db.prepare(`INSERT INTO remote_pi_origin_projections (run_id, remote_card_id, origin_request_id, owner_peer, latest_sequence, acknowledged_sequence, latest_generation, latest_status, last_activity_at, updated_at) VALUES ('pi_run_1', 5, ?, 'kp', 2, 1, 1, 'running', 't', 't')`).run(requestId);
    db.prepare(`INSERT INTO remote_pi_origin_events (run_id, sequence, event_id, content_sha256, projection_json, received_at) VALUES ('pi_run_1', 1, 'evt_pi_1', ?, '{}', 't')`).run(HASH);
    db.prepare(`INSERT INTO remote_pi_commands (origin_peer, command_id, run_id, payload_hash, state, created_at, updated_at) VALUES ('kp', 'cmd_1', 'pi_run_1', ?, 'completed', 't', 't')`).run(HASH);
    db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, created_at, updated_at) VALUES ('peer:kp', 'help.pi', ?, ?, 'completed', 't', 't')`).run(requestId, HASH);
    db.prepare(`INSERT INTO pi_workspace_claims (canonical_path, run_id, execution_generation, owner_kind, acquired_at) VALUES ('/ws', 'pi_run_1', 1, 'standalone', 't')`).run();
    db.prepare(`INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, generation, lifecycle, claimed_at) VALUES ('wa_1', 9, 'c1', 1, 'pi', 'pi_run_1', 1, 'running', 't')`).run();
    db.close();

    const command = JSON.stringify({ version: 1, role: "receiver", runId, command: "snapshot", requestIds: [requestId], marker: runMarker(runId) });
    const result = runProbe(["--home", home, "--role", "receiver", "--run-id", runId, "--command", "snapshot", "--json", Buffer.from(command).toString("base64url")]);
    expect(result.status).toBe(0);
    const { result: parsed } = parseProbeOutput(result.stdout);
    const validation = validateNodeResult(parsed, "receiver", runId);
    expect(validation.ok).toBe(true);
    if (validation.ok && validation.value.kind === "snapshot") {
      const snap = validation.value.value;
      expect(snap.requestIds).toContain(requestId);
      expect(snap.cards).toHaveLength(2);
      expect(snap.cards[0]?.markerPresent).toBe(true);
      expect(snap.contributions).toHaveLength(1);
      expect(snap.contributions[0]?.state).toBe("completed");
      expect(snap.helpRequests).toHaveLength(1);
      expect(snap.helpRequests[0]?.responseDecision).toBe("accepted");
      expect(snap.supervisions[0]?.state).toBe("accepted");
      expect(snap.reviewDecisions[0]?.action).toBe("accept");
      expect(snap.acceptanceOutbox[0]?.sentAt).toBe("t");
      expect(snap.piRuns).toHaveLength(1);
      expect(snap.piRuns[0]?.status).toBe("running");
      expect(snap.piEvents).toHaveLength(1);
      expect(snap.piEvents[0]?.acknowledgedAt).toBeNull();
      expect(snap.piCommands[0]?.state).toBe("completed");
      expect(snap.piApiRequests[0]?.operation).toBe("help.pi");
      expect(snap.workspaceClaims).toHaveLength(1);
      expect(snap.workerAttempts[0]?.lifecycle).toBe("running");
      expect(snap.processFacts[0]?.observedPidPresent).toBe(true);
      expect(JSON.stringify(snap)).not.toContain("peer-r");
      expect(JSON.stringify(snap)).not.toContain("/ws");
    }
  });

  it("fails closed on a missing correlation", () => {
    const db = new DatabaseSync(join(home, "kanban", "kanban.db"));
    db.exec(`CREATE TABLE kanban_board (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, goal TEXT)`);
    db.close();
    const command = JSON.stringify({ version: 1, role: "receiver", runId: "rs-none", command: "snapshot", requestIds: [] });
    const result = runProbe(["--home", home, "--role", "receiver", "--run-id", "rs-none", "--command", "snapshot", "--json", Buffer.from(command).toString("base64url")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NO_CORRELATION");
  });
});

// ── Controller state machine with scripted ports ────────────────────────────

describe("controller foundation profile", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = tmpdirFixture();
    home = join(root, "home");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function buildDeps(opts: {
    runId: string;
    profile: RemoteSwarmLiveProfileV1;
    requesterPort: CommandPort;
    receiverPort: CommandPort;
    delegate: HttpDelegatePort;
    orcCall?: OrcCallPort;
    allowRestarts?: boolean;
  }) {
    return {
      profile: opts.profile,
      profileName: "foundation" as const,
      runId: opts.runId,
      expectedCommit: "abc123def456",
      allowRestarts: opts.allowRestarts ?? false,
      allowResume: false,
      requesterPort: opts.requesterPort,
      receiverPort: opts.receiverPort,
      delegate: opts.delegate,
      orcCall: opts.orcCall,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      sleep: fastSleep,
      probeTimeoutMs: 5_000,
    };
  }

  it("passes the accepted journey, replay, declined, no-relay, and cleanup", async () => {
    const runId = `rs-test-${Date.now()}`;
    const acceptedRequestId = `swarm-${runId}-f1-accepted`;
    const declinedRequestId = `swarm-${runId}-f1-declined`;
    const inboundRequestId = `swarm-${runId}-f1-norelay-inbound`;
    const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
    const { profile } = profileWithFakeNode(root, fakeNode);

    writeSnapshotFixture(fakeNodeDir, "requester", runId, { requestIds: [acceptedRequestId], declinedRequestId, inboundRequestId });
    writeSnapshotFixture(fakeNodeDir, "receiver", runId, { requestIds: [acceptedRequestId], declinedRequestId });

    const delegate: HttpDelegatePort = async (body) => {
      return {
        ok: true,
        decision: "accepted",
        projectCardId: 303,
        proxyCardId: 202,
        requestId: body.request_id,
        contributionRef: "help_abcd1234",
      };
    };
    const orcReplies: OrcCallResult = { reply: "peer_relay_blocked was returned by the tool", sessionId: "sess-1" };
    const orcCall: OrcCallPort = { call: async () => orcReplies };

    const deps = buildDeps({ runId, profile, requesterPort, receiverPort, delegate, orcCall });
    const result = await runRemoteSwarmLiveE2E(deps);

    expect(result.state).toBe("passed");
    expect(result.scenarios.map((s) => s.id)).toEqual(["preflight", "clean-prior-run-id", "accepted-journey", "replay-idempotent", "declined-admission", "no-relay-rejection"]);
    for (const scenario of result.scenarios) {
      expect(scenario.state, scenario.id).toBe("passed");
    }
    expect(result.cleanup.state).toBe("passed");

    const evidenceRoot = join(profile.evidenceRoot, runId);
    expect(existsSync(join(evidenceRoot, "result.json"))).toBe(true);
    expect(existsSync(join(evidenceRoot, "junit.xml"))).toBe(true);
    expect(existsSync(join(evidenceRoot, "events.jsonl"))).toBe(true);
    const written = JSON.parse(readFileSync(join(evidenceRoot, "result.json"), "utf-8")) as unknown;
    expect(validateLiveResult(written).ok).toBe(true);
    const junit = readFileSync(join(evidenceRoot, "junit.xml"), "utf-8");
    expect(junit).toContain("<testsuite");
  });

  it("fails the accepted journey when exactly-once counts are violated", async () => {
    const runId = `rs-dupe-${Date.now()}`;
    const acceptedRequestId = `swarm-${runId}-f1-accepted`;
    const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
    const { profile } = profileWithFakeNode(root, fakeNode);
    writeSnapshotFixture(fakeNodeDir, "requester", runId, { requestIds: [acceptedRequestId] });
    writeSnapshotFixture(fakeNodeDir, "receiver", runId, { requestIds: [acceptedRequestId], receiverCards: 2 });
    const delegate = makeStatefulDelegate("help_abcd1234", 303, 202);
    const deps = buildDeps({ runId, profile, requesterPort, receiverPort, delegate });
    const result = await runRemoteSwarmLiveE2E(deps);
    expect(result.state).toBe("failed");
    const journey = result.scenarios.find((s) => s.id === "accepted-journey");
    expect(journey?.state).toBe("failed");
    expect(journey?.failure?.message).toContain("receiver O cards");
  });

  it("blocks preflight on incompatible builds", async () => {
    const runId = `rs-mismatch-${Date.now()}`;
    const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
    const { profile } = profileWithFakeNode(root, fakeNode);
    writePreflightFixture(fakeNodeDir, "requester", runId, { build: { manifestPresent: true, commit: "ffffffffffff", branch: "dev", version: "0.4.1", source: "dev", matchesExpected: false } });
    const delegate = makeStatefulDelegate("help_abcd1234", 303, 202);
    const deps = buildDeps({ runId, profile, requesterPort, receiverPort, delegate });
    const result = await runRemoteSwarmLiveE2E(deps);
    expect(result.state).toBe("failed");
    expect(result.scenarios[0]?.id).toBe("preflight");
    expect(result.scenarios[0]?.state).toBe("failed");
    expect(result.failure?.message).toContain("do not match");
  });

  it("blocks declined/no-relay when no Orc surface is configured", async () => {
    const runId = `rs-no-orc-${Date.now()}`;
    const acceptedRequestId = `swarm-${runId}-f1-accepted`;
    const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
    const { profile } = profileWithFakeNode(root, fakeNode);
    writeSnapshotFixture(fakeNodeDir, "requester", runId, { requestIds: [acceptedRequestId] });
    writeSnapshotFixture(fakeNodeDir, "receiver", runId, { requestIds: [acceptedRequestId] });
    const delegate = makeStatefulDelegate("help_abcd1234", 303, 202);
    const deps = buildDeps({ runId, profile, requesterPort, receiverPort, delegate });
    const result = await runRemoteSwarmLiveE2E(deps);
    expect(result.state).toBe("blocked");
    const declined = result.scenarios.find((s) => s.id === "declined-admission");
    const noRelay = result.scenarios.find((s) => s.id === "no-relay-rejection");
    expect(declined?.state).toBe("blocked");
    expect(noRelay?.state).toBe("blocked");
    expect(result.scenarios.filter((s) => s.id === "accepted-journey")[0]?.state).toBe("passed");
  });
});

describe("controller full profile", () => {
  it("blocks the recovery scenario without --allow-restarts", async () => {
    const { profile } = makeProfile();
    const runId = `rs-full-${Date.now()}`;
    const ctx: Parameters<typeof runFull>[0] = {
      runId,
      marker: runMarker(runId),
      profile,
      expectedCommit: "abc123def456",
      allowRestarts: false,
      allowResume: false,
      probes: null as unknown as ProbeClient,
      delegate: async () => ({ ok: false, decision: "error", error: "not reached" }),
      orcCall: null,
      onEvent: () => {},
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      sleep: fastSleep,
      tracked: newTrackedObjects(),
    };
    const scenarios = await runFull(ctx);
    const recovery = scenarios.find((s) => s.id === "recovery-restarts");
    expect(recovery?.state).toBe("blocked");
    expect(recovery?.failure?.code).toBe("RESTARTS_NOT_ALLOWED");
  });
});

describe("cleanup", () => {
  it("fails when a tracked Pi run is not terminal", async () => {
    const root = tmpdirFixture();
    try {
      const runId = `rs-clean-${Date.now()}`;
      const acceptedRequestId = `swarm-${runId}-f1-accepted`;
      const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
      const { profile } = profileWithFakeNode(root, fakeNode);
      writeSnapshotFixture(fakeNodeDir, "requester", runId, { requestIds: [acceptedRequestId], piRun: { runId: "pi_run_x", status: "running" } });
      writeSnapshotFixture(fakeNodeDir, "receiver", runId, { requestIds: [acceptedRequestId], piRun: { runId: "pi_run_x", status: "running" } });
      const delegate = makeStatefulDelegate("help_abcd1234", 303, 202);
      const deps = {
        profile,
        profileName: "foundation" as const,
        runId,
        expectedCommit: "abc123def456",
        allowRestarts: false,
        allowResume: false,
        requesterPort,
        receiverPort,
        delegate,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
        sleep: fastSleep,
        probeTimeoutMs: 5_000,
      };
      const result = await runRemoteSwarmLiveE2E(deps);
      expect(result.cleanup.state).toBe("failed");
      const piAssertion = result.cleanup.assertions.find((a) => a.id === "pi-run-pi_run_x");
      expect(piAssertion?.passed).toBe(false);
      expect(result.state).not.toBe("passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes terminal assertions for a cancelled Pi run", async () => {
    const root = tmpdirFixture();
    try {
      const runId = `rs-clean-ok-${Date.now()}`;
      const acceptedRequestId = `swarm-${runId}-f1-accepted`;
      const { requesterPort, receiverPort, fakeNodeDir, fakeNode } = makeFakePorts(root, runId);
      const { profile } = profileWithFakeNode(root, fakeNode);
      writeSnapshotFixture(fakeNodeDir, "requester", runId, { requestIds: [acceptedRequestId], piRun: { runId: "pi_run_ok", status: "cancelled" } });
      writeSnapshotFixture(fakeNodeDir, "receiver", runId, { requestIds: [acceptedRequestId], piRun: { runId: "pi_run_ok", status: "cancelled" } });
      const delegate = makeStatefulDelegate("help_abcd1234", 303, 202);
      const deps = {
        profile,
        profileName: "foundation" as const,
        runId,
        expectedCommit: "abc123def456",
        allowRestarts: false,
        allowResume: false,
        requesterPort,
        receiverPort,
        delegate,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
        sleep: fastSleep,
        probeTimeoutMs: 5_000,
      };
      const result = await runRemoteSwarmLiveE2E(deps);
      expect(result.cleanup.state).toBe("passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("probe client and output parsing", () => {
  it("parses result and event markers from probe output", () => {
    const line = `REMOTE_SWARM_NODE_EVENT={"stage":"x"}\nREMOTE_SWARM_NODE_RESULT={"kind":"preflight"}\n`;
    const { result, events } = parseProbeOutput(line);
    expect(result).toEqual({ kind: "preflight" });
    expect(events).toEqual([{ stage: "x" }]);
  });

  it("rejects a probe result whose run id does not match", async () => {
    const root = tmpdirFixture();
    try {
      const runId = "rs-probe-mismatch";
      const fakeNodeDir = join(root, "fixtures");
      mkdirSync(fakeNodeDir, { recursive: true });
      const fakeNode = writeFakeNode(fakeNodeDir);
      const { profile } = profileWithFakeNode(root, fakeNode);
      writePreflightFixture(fakeNodeDir, "requester", "rs-WRONG");
      const requesterPort = new LocalCommandPort();
      const receiverPort = new TmuxCommandPort({ session: "rs-test", pollMs: 20, tmuxBin: writeFakeTmux(root) });
      const client = new ProbeClient(profile, requesterPort, receiverPort, () => {}, 5_000);
      await expect(client.run({ version: 1, role: "requester", runId, command: "preflight" })).rejects.toThrow(/does not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a failed probe command", async () => {
    const root = tmpdirFixture();
    try {
      const runId = "rs-probe-fail";
      const fakeNodeDir = join(root, "fixtures");
      mkdirSync(fakeNodeDir, { recursive: true });
      const fakeNode = writeFakeNode(fakeNodeDir);
      const { profile } = profileWithFakeNode(root, fakeNode);
      const requesterPort = new LocalCommandPort();
      const receiverPort = new TmuxCommandPort({ session: "rs-test", pollMs: 20, tmuxBin: writeFakeTmux(root) });
      const client = new ProbeClient(profile, requesterPort, receiverPort, () => {}, 5_000);
      await expect(client.run({ version: 1, role: "requester", runId, command: "preflight" })).rejects.toThrow(/NO_FAKE|no fixture/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evidence writer", () => {
  it("writes atomic result and junit artifacts", () => {
    const root = tmpdirFixture();
    try {
      const writer = new EvidenceWriter(join(root, "evidence"), "rs-evidence");
      const scenario = { id: "s1", name: "s1", state: "passed" as const, startedAt: "t", finishedAt: "t", durationMs: 1, failure: null, evidence: [] };
      const result = {
        version: 1 as const,
        runId: "rs-evidence",
        profile: "foundation" as const,
        expectedCommit: "abcd1234",
        requesterBuild: "",
        receiverBuild: "",
        startedAt: "t",
        finishedAt: "t",
        state: "passed" as const,
        scenarios: [scenario],
        cleanup: { state: "passed" as const, assertions: [] },
        failure: null,
      };
      writer.writeResult(result);
      writer.writeJunit(result);
      writer.appendEvent({ ts: "t", stage: "x", node: "controller", message: "m" });
      const resultPath = join(root, "evidence", "rs-evidence", "result.json");
      const junitPath = join(root, "evidence", "rs-evidence", "junit.xml");
      expect(existsSync(resultPath)).toBe(true);
      expect(existsSync(junitPath)).toBe(true);
      const junit = readFileSync(junitPath, "utf-8");
      expect(junit).toContain("<testcase");
      const events = readFileSync(join(root, "evidence", "rs-evidence", "events.jsonl"), "utf-8");
      expect(events).toContain("REMOTE_SWARM_EVENT=");
      expect(validateLiveResult(JSON.parse(readFileSync(resultPath, "utf-8")) as unknown).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("receiver-side delegate", () => {
  it("routes the receiver delegate through the tmux port as a quoted curl command", async () => {
    const { createHttpDelegatePort } = await import("./remote-swarm-live-e2e.ts");
    const root = tmpdirFixture();
    try {
      const { profile } = makeProfile();
      let captured: CommandArg[] | null = null;
      const fakeReceiverPort: CommandPort = {
        run: async (argv) => {
          captured = argv;
          return { ok: true, exitCode: 0, stdout: JSON.stringify({ ok: true, decision: "accepted", request_id: "r1", contribution_ref: "help_x" }), stderr: "", timedOut: false };
        },
      };
      const delegate = createHttpDelegatePort(profile, fakeReceiverPort);
      const result = await delegate({ peer: "peer-r", goal: "a goal with spaces", request_id: "r1" }, "receiver");
      expect(result.ok).toBe(true);
      expect(result.decision).toBe("accepted");
      expect(captured).not.toBeNull();
      const argv = captured ?? [];
      expect(argv[0]?.text).toBe("curl");
      expect(argv.map((a) => a.text).join(" ")).toContain("https://127.0.0.1:17101/v1/orc/delegate");
      const dashD = argv.find((a) => a.text === "-d");
      const payloadArg = argv[argv.indexOf(dashD ?? { text: "-d" }) + 1];
      expect(payloadArg?.quote).toBe(true);
      expect(JSON.parse(payloadArg?.text ?? "{}")).toEqual({ peer: "peer-r", goal: "a goal with spaces", request_id: "r1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("builds unique run ids and markers", () => {
    const runId = buildRunId(new Date(1_700_000_000_000));
    expect(runId).toMatch(/^rs-live-\d+-[0-9a-f]{6}$/);
    const marker = runMarker(runId);
    expect(marker).toContain(runId);
    expect(marker).toContain("remote-swarm-e2e");
  });

  it("pollUntil resolves and times out", async () => {
    let count = 0;
    const value = await pollUntil("x", async () => (count++ >= 3 ? "yes" : null), 5_000, { intervalMs: 1, sleep: fastSleep });
    expect(value).toBe("yes");
    await expect(pollUntil("y", async () => null, 50, { intervalMs: 10, sleep: fastSleep })).rejects.toThrow(/timed out/);
  });

  it("builds a resume approval whose statement hash verifies", async () => {
    const { buildResumeApproval } = await import("./remote-swarm-live-e2e.ts");
    const approval = buildResumeApproval({ runId: "pi_1", generation: 2, commandId: "c1", originPeer: "peer-r", now: () => new Date("2026-08-15T00:00:00.000Z") });
    expect(approval.approvalStatementSha256).toHaveLength(64);
    const statement = JSON.stringify({
      approval_id: approval.approvalId,
      run_id: "pi_1",
      origin_peer: "peer-r",
      command_id: "c1",
      approving_principal: "peer-r",
      issued_at: approval.issuedAt,
      expires_at: approval.expiresAt,
      interrupted_generation: 2,
    });
    expect(createHash("sha256").update(statement, "utf-8").digest("hex")).toBe(approval.approvalStatementSha256);
  });
});
