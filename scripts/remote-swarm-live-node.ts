#!/usr/bin/env node
/**
 * remote-swarm-live-node.ts — #1624 host-local probe for the live two-node
 * swarm acceptance driver.
 *
 * Runs inside each deployed source tree with plain `node` (type stripping).
 * Read-only: never writes SQLite, config, or lock files. Emits
 * REMOTE_SWARM_NODE_RESULT=<json> on stdout; failures emit
 * REMOTE_SWARM_NODE_ERROR=<json> and exit non-zero.
 *
 * Erasable-syntax only so `node` can strip types without a build step.
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from "node:crypto";
import * as https from "node:https";
import type { TLSSocket } from "node:tls";

import {
  CONTRACT_BOUNDS,
  REMOTE_SWARM_PROBE_RESULT_MARKER,
  validateNodeCommand,
  type RemoteSwarmLogTailV1,
  type RemoteSwarmNodeCommandV1,
  type RemoteSwarmNodePreflightV1,
  type RemoteSwarmPiControlResultV1,
  type RemoteSwarmPiControlRequestV1,
  type RemoteSwarmSnapshotV1,
  type RemoteSwarmRole,
} from "./remote-swarm-live-contracts.ts";

const bounds = CONTRACT_BOUNDS;

function fail(code: string, message: string): never {
  process.stderr.write(`REMOTE_SWARM_NODE_ERROR=${JSON.stringify({ code, message: message.slice(0, 2_000) })}\n`);
  process.exit(1);
}

function readJsonBounded(path: string, maxBytes: number): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  if (raw.length > maxBytes) fail("FILE_TOO_LARGE", `${path} exceeds ${maxBytes} bytes`);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    fail("BAD_JSON", `${path} is not valid JSON`);
  }
}

function homeDirOf(abtarsHome: string): string {
  return abtarsHome || join(homedir(), ".abtars");
}

function trim(value: string, max?: number): string {
  const limit = max ?? bounds.evidenceString;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...(truncated)`;
}

function redact(value: string): string {
  const patterns: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /ENC:[A-Za-z0-9+/=_-]{8,}/g,
    /sk-[A-Za-z0-9_-]{16,}/g,
    // Long opaque tokens, excluding pure-lowercase-hex digests (evidence).
    /[A-Za-z0-9+/]{64,}={0,2}/g,
  ];
  let out = value;
  for (const pattern of patterns) {
    out = out.replace(pattern, (match) => (/^[0-9a-f]{64}$/.test(match) ? match : "[redacted]"));
  }
  return out;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(trim(value));
  if (Array.isArray(value)) return value.slice(0, bounds.rows).map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

interface ParsedArgs {
  home: string;
  role: RemoteSwarmRole;
  runId: string;
  command: RemoteSwarmNodeCommandV1;
}

function parseProbeArgs(argv: string[]): ParsedArgs {
  const options = {
    home: { type: "string" as const },
    role: { type: "string" as const },
    "run-id": { type: "string" as const },
    command: { type: "string" as const },
    "expected-commit": { type: "string" as const },
    "require-pi-alias": { type: "string" as const },
    marker: { type: "string" as const },
    peer: { type: "string" as const },
    json: { type: "string" as const },
    lines: { type: "string" as const },
  };
  const { values } = parseArgs({ args: argv, allowPositionals: false, options });

  const home = values.home;
  const role = values.role;
  const runId = values["run-id"];
  const command = values.command;
  if (typeof home !== "string" || home.length === 0) fail("BAD_ARGS", "missing --home");
  if (role !== "requester" && role !== "receiver") fail("BAD_ARGS", "--role must be requester or receiver");
  if (typeof runId !== "string" || runId.length < 3 || runId.length > bounds.runId) fail("BAD_ARGS", "invalid --run-id");
  if (command !== "preflight" && command !== "snapshot" && command !== "remote-pi-control" && command !== "log-tail") {
    fail("BAD_ARGS", `unknown --command ${String(command)}`);
  }

  const cmd: RemoteSwarmNodeCommandV1 = {
    version: 1,
    role,
    runId,
    command,
  };
  if (values.json !== undefined) {
    let decoded: string;
    try {
      decoded = Buffer.from(values.json, "base64url").toString("utf-8");
    } catch {
      fail("BAD_ARGS", "--json is not valid base64url");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      fail("BAD_ARGS", "--json is not valid JSON");
    }
    const validation = validateNodeCommand(parsed);
    if (!validation.ok) fail("BAD_ARGS", `invalid --json payload: ${validation.error}`);
    const validated = validation.value;
    if (validated.role !== role || validated.runId !== runId || validated.command !== command) {
      fail("BAD_ARGS", "--json command does not match the flag arguments");
    }
    cmd.expectedCommit = validated.expectedCommit;
    cmd.requirePiAlias = validated.requirePiAlias;
    cmd.marker = validated.marker;
    cmd.requestIds = validated.requestIds;
    cmd.peer = validated.peer;
    cmd.lines = validated.lines;
    cmd.pi = validated.pi;
  } else {
    if (values["expected-commit"] !== undefined) cmd.expectedCommit = values["expected-commit"];
    if (values["require-pi-alias"] !== undefined) cmd.requirePiAlias = values["require-pi-alias"];
    if (values.marker !== undefined) cmd.marker = values.marker;
    if (values.peer !== undefined) cmd.peer = values.peer;
    if (values.lines !== undefined) cmd.lines = Math.max(1, Math.min(Number(values.lines) || 200, bounds.tailLines));
  }

  return { home: homeDirOf(home), role, runId, command: cmd };
}

function emitResult(kind: string, value: unknown): never {
  const payload = JSON.stringify({ kind, value: redactDeep(value) });
  process.stdout.write(`${REMOTE_SWARM_PROBE_RESULT_MARKER}${payload}\n`);
  process.exit(0);
}

// ── preflight ────────────────────────────────────────────────────────────────

function preflight(args: ParsedArgs): RemoteSwarmNodePreflightV1 {
  const home = args.home;
  const manifest = readJsonBounded(join(home, "manifest.json"), 64_000);
  const lock = readJsonBounded(join(home, "bridge.lock"), 64_000);
  const snapshot = readJsonBounded(join(home, "state", "runtime-health-v1.json"), 256_000);
  const peersConfig = readJsonBounded(join(home, "config", "peers.json"), 128_000);
  const piConfig = readJsonBounded(join(home, "config", "pi-executor.json"), 128_000);
  const transportConfig = readJsonBounded(join(home, "config", "transport.json"), 256_000);

  const build: RemoteSwarmNodePreflightV1["build"] = {
    manifestPresent: manifest !== null,
    commit: manifest !== null && typeof manifest.commit === "string" ? trim(manifest.commit, 64) : null,
    branch: manifest !== null && typeof manifest.branch === "string" ? trim(manifest.branch, 64) : null,
    version: manifest !== null && typeof manifest.version === "string" ? trim(manifest.version, 64) : null,
    source: manifest !== null && typeof manifest.source === "string" ? trim(manifest.source, 64) : null,
    matchesExpected: false,
  };
  if (args.command.expectedCommit && build.commit) {
    const expected = args.command.expectedCommit.toLowerCase();
    const actual = build.commit.toLowerCase();
    // Deployments record short SHAs of varying length; either side may be
    // the shorter prefix.
    build.matchesExpected = actual.startsWith(expected) || expected.startsWith(actual);
  }

  const heartbeatFresh = lock !== null && typeof lock.lastHeartbeat === "number"
    && Date.now() - (lock.lastHeartbeat as number) < 240_000;
  const bridge: RemoteSwarmNodePreflightV1["bridge"] = {
    running: lock !== null && typeof lock.pid === "number",
    pid: lock !== null && typeof lock.pid === "number" ? (lock.pid as number) : null,
    startedAt: lock !== null && typeof lock.startedAt === "number" ? new Date(lock.startedAt as number).toISOString() : null,
    heartbeatFresh,
    startIdentity: lock !== null && typeof lock.startIdentity === "string" ? trim(lock.startIdentity, 128) : null,
    sleepStatus: lock !== null && typeof lock.sleepStatus === "string" ? trim(lock.sleepStatus, 64) : null,
  };

  const peerApiRaw = snapshot !== null && "peerApi" in snapshot && typeof snapshot.peerApi === "object" && snapshot.peerApi !== null
    ? snapshot.peerApi as Record<string, unknown>
    : null;
  const peerApi: RemoteSwarmNodePreflightV1["peerApi"] = {
    state: peerApiRaw !== null && typeof peerApiRaw.state === "string" ? trim(peerApiRaw.state, 64) : null,
    port: null,
    runtimeSnapshotPresent: snapshot !== null,
  };

  const routesRaw = snapshot !== null && Array.isArray(snapshot.routes)
    ? snapshot.routes as Array<Record<string, unknown>>
    : [];
  let expectedPeerRoute = false;
  let authenticated = false;
  let direction: string | null = null;
  let connectedAt: string | null = null;
  let otherRoutes = 0;
  for (const route of routesRaw.slice(0, 64)) {
    const peer = typeof route.peer === "string" ? route.peer : null;
    if (peer !== null && peer === args.command.peer) {
      expectedPeerRoute = true;
      authenticated = route.authenticated === true;
      const directions = Array.isArray(route.directions) ? route.directions.filter((d): d is string => typeof d === "string") : [];
      direction = directions[0] ?? null;
      connectedAt = typeof route.connectedAt === "string" ? trim(route.connectedAt, 64) : null;
    } else {
      otherRoutes++;
    }
  }
  const route: RemoteSwarmNodePreflightV1["route"] = { expectedPeerRoute, authenticated, direction, connectedAt, otherRoutes };

  const peersMap = peersConfig !== null && typeof peersConfig.peers === "object" && peersConfig.peers !== null
    ? peersConfig.peers as Record<string, unknown>
    : {};
  const selfBlock = peersConfig !== null && typeof peersConfig.self === "object" && peersConfig.self !== null
    ? peersConfig.self as Record<string, unknown>
    : null;
  const enrollment: RemoteSwarmNodePreflightV1["enrollment"] = {
    selfEnrolled: selfBlock !== null && typeof selfBlock.name === "string" && typeof selfBlock.signingKey === "string",
    peersCount: Object.keys(peersMap).length,
  };

  const aliases = piConfig !== null && typeof piConfig.workspaceAliases === "object" && piConfig.workspaceAliases !== null
    ? piConfig.workspaceAliases as Record<string, unknown>
    : {};
  const workspaceAliasPresent = args.command.requirePiAlias
    ? args.command.requirePiAlias in aliases
    : Object.keys(aliases).length > 0;
  const capabilities: RemoteSwarmNodePreflightV1["capabilities"] = {
    piExecutorConfigured: Object.keys(aliases).length > 0,
    workspaceAliasPresent,
  };

  const secretDir = join(home, "secret");
  let providerSecretPresent = false;
  try {
    if (existsSync(secretDir)) {
      const names = readdirSync(secretDir).filter((name) => /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || /^(API_KEY|OPENAI_API_KEY)$/.test(name));
      providerSecretPresent = names.length > 0;
    }
  } catch { /* absent store */ }

  let transportPresent = existsSync(join(home, "config", "transport.json"));
  if (transportConfig !== null && typeof transportConfig.providers === "object" && transportConfig.providers !== null) {
    const providers = transportConfig.providers as Record<string, unknown>;
    for (const provider of Object.values(providers)) {
      if (provider !== null && typeof provider === "object" && typeof (provider as Record<string, unknown>).apiKeyEnv === "string") {
        const envName = (provider as Record<string, unknown>).apiKeyEnv as string;
        const inSecretStore = providerSecretPresent || (() => {
          try { return existsSync(join(secretDir, envName)); } catch { return false; }
        })();
        if (!inSecretStore && !(envName in process.env)) transportPresent = false;
      }
    }
  }

  const credentials: RemoteSwarmNodePreflightV1["credentials"] = {
    transportJson: transportPresent,
    modelsJson: existsSync(join(home, "config", "models.json")),
    usersJson: existsSync(join(home, "config", "users.json")),
    providerSecretPresent,
    identityKeyPresent: existsSync(join(home, "config", "identity.tls.key")) || existsSync(join(home, "config", "abtars.key")),
    peersJson: peersConfig !== null,
  };

  return {
    version: 1,
    role: args.role,
    runId: args.runId,
    probeSchemaVersion: 1,
    nodeVersion: process.versions.node,
    build,
    bridge,
    peerApi,
    route,
    enrollment,
    capabilities,
    credentials,
  };
}

// ── snapshot ─────────────────────────────────────────────────────────────────

interface SnapshotDb {
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
}

async function openReadonlyDb(path: string): Promise<SnapshotDb | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    return {
      prepare: (sql) => ({
        all: (...params) => db.prepare(sql).all(...params as Array<string | number | null>) as Array<Record<string, unknown>>,
        get: (...params) => db.prepare(sql).get(...params as Array<string | number | null>) as Record<string, unknown> | undefined,
      }),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

function parseNotesJson(notes: unknown): Record<string, unknown> {
  if (typeof notes !== "string" || notes.length > 16_384) return {};
  try {
    const parsed = JSON.parse(notes) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOf(value: unknown, max?: number): string | null {
  return typeof value === "string" ? trim(value, max ?? bounds.evidenceString) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function inPlaceholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

async function snapshot(args: ParsedArgs): Promise<RemoteSwarmSnapshotV1> {
  const home = args.home;
  const db = await openReadonlyDb(join(home, "kanban", "kanban.db"));
  if (db === null) fail("DB_OPEN_FAILED", "kanban.db cannot be opened read-only");
  try {
    const marker = args.command.marker ?? "";
    const requestIds = new Set(args.command.requestIds ?? []);
    const seenCardIds = new Set<number>();
    const correlatedCards: Array<Record<string, unknown>> = [];

    const collectCards = (rows: Array<Record<string, unknown>>): void => {
      for (const row of rows) {
        const id = row.id;
        if (typeof id === "number" && !seenCardIds.has(id)) {
          seenCardIds.add(id);
          correlatedCards.push(row);
        }
      }
    };

    if (marker) {
      collectCards(db.prepare(
        "SELECT id FROM kanban_board WHERE instr(COALESCE(goal,''), ?) > 0 OR instr(COALESCE(notes,''), ?) > 0 LIMIT ?",
      ).all(marker, marker, bounds.cards));
    }
    if (requestIds.size > 0) {
      collectCards(db.prepare(
        `SELECT id FROM kanban_board WHERE source_id IN (${inPlaceholders(Array.from(requestIds))}) LIMIT ?`,
      ).all(...Array.from(requestIds), bounds.cards));
    }

    const cardIds: number[] = [];
    for (const row of correlatedCards) {
      if (typeof row.id === "number") cardIds.push(row.id);
    }

    const cardFacts: RemoteSwarmSnapshotV1["cards"] = [];
    const discoveredRefs = new Set<string>();
    const discoveredRunIds = new Set<string>();
    for (const cardId of cardIds) {
      const card = db.prepare(
        `SELECT id, type, status, source, source_id, parent_id, delivery_mode, delivery_result, result_summary, goal, notes
         FROM kanban_board WHERE id = ?`,
      ).get(cardId);
      if (!card) continue;
      const notes = parseNotesJson(card.notes);
      const goal = stringOf(card.goal) ?? "";
      const notesRequestId = stringOf(notes.request_id, bounds.requestId);
      const notesContributionRef = stringOf(notes.contribution_ref, bounds.contributionRef);
      const notesRemoteRunId = stringOf(notes.remote_run_id, bounds.id);
      if (notesRequestId) requestIds.add(notesRequestId);
      if (notesContributionRef) discoveredRefs.add(notesContributionRef);
      if (notesRemoteRunId) discoveredRunIds.add(notesRemoteRunId);
      cardFacts.push({
        id: cardId,
        type: stringOf(card.type, 32) ?? "",
        status: stringOf(card.status, 32) ?? "",
        source: stringOf(card.source, 32) ?? "",
        sourceId: stringOf(card.source_id, bounds.requestId),
        parentId: numberOrNull(card.parent_id),
        deliveryMode: stringOf(card.delivery_mode, 32) ?? "",
        deliveryResult: stringOf(card.delivery_result, 64),
        resultSummary: stringOf(card.result_summary),
        markerPresent: marker !== "" && (goal.includes(marker) || (typeof card.notes === "string" && card.notes.includes(marker))),
        notesRequestId,
        notesContributionRef,
        notesOutcome: stringOf(notes.outcome, 32),
        notesRemoteRunId,
        notesHelpDecision: stringOf(notes.help_decision, 32),
      });
    }

    if (requestIds.size === 0 && discoveredRefs.size === 0 && discoveredRunIds.size === 0 && marker === "") {
      fail("NO_CORRELATION", "snapshot requires request ids or a run marker");
    }

    const requestIdList = Array.from(requestIds).slice(0, 32);
    const refList = Array.from(discoveredRefs).slice(0, 32);
    const runIdList = Array.from(discoveredRunIds).slice(0, 32);

    const contributions: RemoteSwarmSnapshotV1["contributions"] = [];
    if (requestIdList.length > 0 || refList.length > 0) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (requestIdList.length > 0) {
        where.push(`request_id IN (${inPlaceholders(requestIdList)})`);
        params.push(...requestIdList);
      }
      if (refList.length > 0) {
        where.push(`contribution_ref IN (${inPlaceholders(refList)})`);
        params.push(...refList);
      }
      const rows = db.prepare(
        `SELECT request_id, request_hash, contribution_ref, state, last_sequence, terminal_event_id, terminal_digest, projection_json
         FROM peer_contributions WHERE ${where.join(" OR ")} LIMIT ?`,
      ).all(...params, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const projectionJson = stringOf(row.projection_json, 16_384);
        let projection: RemoteSwarmSnapshotV1["contributions"][number]["projection"] = null;
        if (projectionJson) {
          try {
            const parsed = JSON.parse(projectionJson) as Record<string, unknown>;
            const provenance = parsed.provenance as Record<string, unknown> | undefined;
            projection = {
              outcome: typeof parsed.outcome === "string" ? trim(parsed.outcome, 32) : null,
              receiverProjectRef: stringOf(provenance?.receiver_project_ref, 128),
              acceptanceId: stringOf(provenance?.acceptance_id, 128),
              acceptedAt: stringOf(provenance?.accepted_at, 64),
            };
          } catch { /* keep null */ }
        }
        contributions.push({
          requestId: stringOf(row.request_id, bounds.requestId) ?? "",
          contributionRef: stringOf(row.contribution_ref, bounds.contributionRef) ?? "",
          requestHash: stringOf(row.request_hash, bounds.hash) ?? "",
          state: stringOf(row.state, 32) ?? "",
          lastSequence: typeof row.last_sequence === "number" ? row.last_sequence : -1,
          terminalEventId: stringOf(row.terminal_event_id, bounds.id),
          terminalDigest: stringOf(row.terminal_digest, bounds.hash),
          projection,
        });
      }
    }

    const contributionEvents: RemoteSwarmSnapshotV1["contributionEvents"] = [];
    if (requestIdList.length > 0) {
      const rows = db.prepare(
        `SELECT event_id, request_id, contribution_ref, sequence, payload_digest, projection_json
         FROM peer_contribution_events WHERE request_id IN (${inPlaceholders(requestIdList)}) LIMIT ?`,
      ).all(...requestIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const eventJson = stringOf(row.projection_json, 16_384);
        let kind = "unknown";
        if (eventJson) {
          try {
            const parsed = JSON.parse(eventJson) as Record<string, unknown>;
            if (typeof parsed.kind === "string") kind = trim(parsed.kind, 32);
          } catch { /* keep unknown */ }
        }
        contributionEvents.push({
          eventId: stringOf(row.event_id, bounds.id) ?? "",
          requestId: stringOf(row.request_id, bounds.requestId) ?? "",
          contributionRef: stringOf(row.contribution_ref, bounds.contributionRef) ?? "",
          sequence: typeof row.sequence === "number" ? row.sequence : 0,
          kind,
          payloadDigest: stringOf(row.payload_digest, bounds.hash) ?? "",
        });
      }
    }

    const helpRequests: RemoteSwarmSnapshotV1["helpRequests"] = [];
    if (requestIdList.length > 0 || refList.length > 0) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (requestIdList.length > 0) {
        where.push(`request_id IN (${inPlaceholders(requestIdList)})`);
        params.push(...requestIdList);
      }
      if (refList.length > 0) {
        where.push(`contribution_ref IN (${inPlaceholders(refList)})`);
        params.push(...refList);
      }
      const rows = db.prepare(
        `SELECT request_id, request_hash, state, contribution_ref, local_card_id, local_run_id, response_json
         FROM peer_help_requests WHERE ${where.join(" OR ")} LIMIT ?`,
      ).all(...params, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const responseJson = stringOf(row.response_json, 16_384);
        let responseDecision: string | null = null;
        let reasonCode: string | null = null;
        let provesNonCreation: boolean | null = null;
        if (responseJson) {
          try {
            const parsed = JSON.parse(responseJson) as Record<string, unknown>;
            responseDecision = typeof parsed.decision === "string" ? trim(parsed.decision, 32) : null;
            reasonCode = typeof parsed.reason_code === "string" ? trim(parsed.reason_code, 64) : null;
            provesNonCreation = parsed.proves_non_creation === true ? true : parsed.proves_non_creation === false ? false : null;
          } catch { /* keep nulls */ }
        }
        helpRequests.push({
          requestId: stringOf(row.request_id, bounds.requestId) ?? "",
          contributionRef: stringOf(row.contribution_ref, bounds.contributionRef),
          state: stringOf(row.state, 32) ?? "",
          localCardId: numberOrNull(row.local_card_id),
          localRunId: stringOf(row.local_run_id, bounds.id),
          responseDecision,
          reasonCode,
          provesNonCreation,
          requestHash: stringOf(row.request_hash, bounds.hash) ?? "",
        });
      }
    }

    const supervisions: RemoteSwarmSnapshotV1["supervisions"] = [];
    const reviewCases: RemoteSwarmSnapshotV1["reviewCases"] = [];
    const reviewDecisions: RemoteSwarmSnapshotV1["reviewDecisions"] = [];
    const acceptanceOutbox: RemoteSwarmSnapshotV1["acceptanceOutbox"] = [];
    if (cardIds.length > 0) {
      const placeholders = inPlaceholders(cardIds.map((id) => String(id)));
      const supRows = db.prepare(
        `SELECT project_card_id, state, generation, review_round, active_review_case_id, accepted_decision_id, blocked_reason
         FROM project_supervision WHERE project_card_id IN (${placeholders}) LIMIT ?`,
      ).all(...cardIds, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of supRows) {
        supervisions.push({
          projectCardId: typeof row.project_card_id === "number" ? row.project_card_id : 0,
          state: stringOf(row.state, 32) ?? "",
          generation: typeof row.generation === "number" ? row.generation : 0,
          reviewRound: typeof row.review_round === "number" ? row.review_round : 0,
          activeReviewCaseId: stringOf(row.active_review_case_id, bounds.id),
          acceptedDecisionId: stringOf(row.accepted_decision_id, bounds.id),
          blockedReason: stringOf(row.blocked_reason, 256),
        });
      }
      const caseRows = db.prepare(
        `SELECT id, project_card_id, generation, round, snapshot_digest, status
         FROM project_review_cases WHERE project_card_id IN (${placeholders}) LIMIT ?`,
      ).all(...cardIds, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of caseRows) {
        reviewCases.push({
          id: stringOf(row.id, bounds.id) ?? "",
          projectCardId: typeof row.project_card_id === "number" ? row.project_card_id : 0,
          generation: typeof row.generation === "number" ? row.generation : 0,
          round: typeof row.round === "number" ? row.round : 0,
          status: stringOf(row.status, 32) ?? "",
          snapshotDigest: stringOf(row.snapshot_digest, bounds.hash) ?? "",
        });
      }
      const caseIds = reviewCases.map((c) => c.id).slice(0, 32);
      if (caseIds.length > 0) {
        const decisionRows = db.prepare(
          `SELECT d.id, d.review_case_id, c.project_card_id, d.decision_json
           FROM project_review_decisions d JOIN project_review_cases c ON c.id = d.review_case_id
           WHERE d.review_case_id IN (${inPlaceholders(caseIds)}) LIMIT ?`,
        ).all(...caseIds, bounds.rows) as Array<Record<string, unknown>>;
        for (const row of decisionRows) {
          const decisionJson = stringOf(row.decision_json, 16_384);
          let action: string | null = null;
          if (decisionJson) {
            try {
              const parsed = JSON.parse(decisionJson) as Record<string, unknown>;
              action = typeof parsed.action === "string" ? trim(parsed.action, 32) : null;
            } catch { /* keep null */ }
          }
          reviewDecisions.push({
            id: stringOf(row.id, bounds.id) ?? "",
            reviewCaseId: stringOf(row.review_case_id, bounds.id) ?? "",
            projectCardId: typeof row.project_card_id === "number" ? row.project_card_id : 0,
            action,
          });
        }
      }
      const outboxRows = db.prepare(
        `SELECT id, project_card_id, attempts, last_error, sent_at
         FROM project_acceptance_outbox WHERE project_card_id IN (${placeholders}) LIMIT ?`,
      ).all(...cardIds, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of outboxRows) {
        acceptanceOutbox.push({
          id: stringOf(row.id, bounds.id) ?? "",
          projectCardId: typeof row.project_card_id === "number" ? row.project_card_id : 0,
          attempts: typeof row.attempts === "number" ? row.attempts : 0,
          sentAt: stringOf(row.sent_at, 64),
          lastError: stringOf(row.last_error, 256),
        });
      }
    }

    const piRuns: RemoteSwarmSnapshotV1["piRuns"] = [];
    const processFacts: RemoteSwarmSnapshotV1["processFacts"] = [];
    if (requestIdList.length > 0 || runIdList.length > 0) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (requestIdList.length > 0) {
        where.push(`origin_request_id IN (${inPlaceholders(requestIdList)})`);
        params.push(...requestIdList);
      }
      if (runIdList.length > 0) {
        where.push(`id IN (${inPlaceholders(runIdList)})`);
        params.push(...runIdList);
      }
      const rows = db.prepare(
        `SELECT id, card_id, status, execution_generation, origin_request_id, workspace_alias, resume_capability, generation_intent, observed_pid, pi_session_file
         FROM pi_runs WHERE ${where.join(" OR ")} LIMIT ?`,
      ).all(...params, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const runId = stringOf(row.id, bounds.id) ?? "";
        const sessionFile = stringOf(row.pi_session_file, 512);
        piRuns.push({
          runId,
          cardId: numberOrNull(row.card_id),
          status: stringOf(row.status, 32) ?? "",
          generation: typeof row.execution_generation === "number" ? row.execution_generation : 0,
          originRequestId: stringOf(row.origin_request_id, bounds.requestId),
          workspaceAlias: stringOf(row.workspace_alias, bounds.workspaceAlias),
          resumeCapability: stringOf(row.resume_capability, 64),
          generationIntent: stringOf(row.generation_intent, 32),
        });
        processFacts.push({
          runId,
          observedPidPresent: typeof row.observed_pid === "number" || typeof row.observed_pid === "string",
          sessionPresent: sessionFile !== null && existsSync(sessionFile),
          resumeCapability: stringOf(row.resume_capability, 64),
          generationIntent: stringOf(row.generation_intent, 32),
        });
      }
    }

    const piEvents: RemoteSwarmSnapshotV1["piEvents"] = [];
    const piCommands: RemoteSwarmSnapshotV1["piCommands"] = [];
    const workspaceClaims: RemoteSwarmSnapshotV1["workspaceClaims"] = [];
    const workerAttempts: RemoteSwarmSnapshotV1["workerAttempts"] = [];
    const piRunIdList = Array.from(new Set(piRuns.map((r) => r.runId))).slice(0, 32);
    if (piRunIdList.length > 0) {
      const placeholders = inPlaceholders(piRunIdList);
      const eventRows = db.prepare(
        `SELECT run_id, sequence, kind, generation, acknowledged_at FROM remote_pi_events WHERE run_id IN (${placeholders}) ORDER BY run_id, sequence LIMIT ?`,
      ).all(...piRunIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of eventRows) {
        piEvents.push({
          runId: stringOf(row.run_id, bounds.id) ?? "",
          sequence: typeof row.sequence === "number" ? row.sequence : 0,
          kind: stringOf(row.kind, 32) ?? "",
          generation: typeof row.generation === "number" ? row.generation : 0,
          acknowledgedAt: stringOf(row.acknowledged_at, 64),
          eventId: null,
        });
      }
      const commandRows = db.prepare(
        `SELECT command_id, run_id, state, payload_hash FROM remote_pi_commands WHERE run_id IN (${placeholders}) LIMIT ?`,
      ).all(...piRunIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of commandRows) {
        piCommands.push({
          commandId: stringOf(row.command_id, bounds.id) ?? "",
          runId: stringOf(row.run_id, bounds.id) ?? "",
          state: stringOf(row.state, 32) ?? "",
          payloadHash: stringOf(row.payload_hash, bounds.hash) ?? "",
        });
      }
      const claimRows = db.prepare(
        `SELECT run_id, execution_generation, owner_kind FROM pi_workspace_claims WHERE run_id IN (${placeholders}) LIMIT ?`,
      ).all(...piRunIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of claimRows) {
        workspaceClaims.push({
          runId: stringOf(row.run_id, bounds.id) ?? "",
          generation: typeof row.execution_generation === "number" ? row.execution_generation : 0,
          ownerKind: stringOf(row.owner_kind, 32) ?? "",
        });
      }
      const attemptRows = db.prepare(
        `SELECT card_id, executor_kind, executor_id, generation, lifecycle FROM worker_attempts
         WHERE executor_kind = 'pi' AND executor_id IN (${placeholders}) LIMIT ?`,
      ).all(...piRunIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of attemptRows) {
        workerAttempts.push({
          cardId: typeof row.card_id === "number" ? row.card_id : 0,
          executorKind: stringOf(row.executor_kind, 32) ?? "",
          executorId: stringOf(row.executor_id, bounds.id) ?? "",
          generation: typeof row.generation === "number" ? row.generation : 0,
          lifecycle: stringOf(row.lifecycle, 32) ?? "",
        });
      }
    }

    const piOriginProjections: RemoteSwarmSnapshotV1["piOriginProjections"] = [];
    const piOriginEvents: RemoteSwarmSnapshotV1["piOriginEvents"] = [];
    if (requestIdList.length > 0 || runIdList.length > 0) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (requestIdList.length > 0) {
        where.push(`origin_request_id IN (${inPlaceholders(requestIdList)})`);
        params.push(...requestIdList);
      }
      if (runIdList.length > 0) {
        where.push(`run_id IN (${inPlaceholders(runIdList)})`);
        params.push(...runIdList);
      }
      const originRows = db.prepare(
        `SELECT run_id, origin_request_id, latest_sequence, acknowledged_sequence, latest_generation, latest_status,
                pending_input_json, result_summary, error_summary, resume_capability
         FROM remote_pi_origin_projections WHERE ${where.join(" OR ")} LIMIT ?`,
      ).all(...params, bounds.rows) as Array<Record<string, unknown>>;
      const originRunIds: string[] = [];
      for (const row of originRows) {
        const runId = stringOf(row.run_id, bounds.id) ?? "";
        originRunIds.push(runId);
        piOriginProjections.push({
          runId,
          originRequestId: stringOf(row.origin_request_id, bounds.requestId),
          latestSequence: typeof row.latest_sequence === "number" ? row.latest_sequence : 0,
          acknowledgedSequence: typeof row.acknowledged_sequence === "number" ? row.acknowledged_sequence : 0,
          latestGeneration: typeof row.latest_generation === "number" ? row.latest_generation : 0,
          latestStatus: stringOf(row.latest_status, 32) ?? "",
          resumeCapability: stringOf(row.resume_capability, 64),
          pendingInputPresent: typeof row.pending_input_json === "string" && row.pending_input_json.length > 0,
          resultSummary: stringOf(row.result_summary),
          errorSummary: stringOf(row.error_summary),
        });
      }
      const uniqueOriginRunIds = Array.from(new Set([...originRunIds, ...piRunIdList])).slice(0, 32);
      if (uniqueOriginRunIds.length > 0) {
        const rows = db.prepare(
          `SELECT run_id, sequence, event_id FROM remote_pi_origin_events WHERE run_id IN (${inPlaceholders(uniqueOriginRunIds)}) LIMIT ?`,
        ).all(...uniqueOriginRunIds, bounds.rows) as Array<Record<string, unknown>>;
        for (const row of rows) {
          piOriginEvents.push({
            runId: stringOf(row.run_id, bounds.id) ?? "",
            sequence: typeof row.sequence === "number" ? row.sequence : 0,
            kind: "origin-event",
            generation: 0,
            acknowledgedAt: null,
            eventId: stringOf(row.event_id, bounds.id),
          });
        }
      }
    }

    const piApiRequests: RemoteSwarmSnapshotV1["piApiRequests"] = [];
    if (requestIdList.length > 0) {
      const rows = db.prepare(
        `SELECT client_id, operation, request_id, state FROM pi_api_requests WHERE request_id IN (${inPlaceholders(requestIdList)}) LIMIT ?`,
      ).all(...requestIdList, bounds.rows) as Array<Record<string, unknown>>;
      for (const row of rows) {
        piApiRequests.push({
          requestId: stringOf(row.request_id, bounds.requestId) ?? "",
          operation: stringOf(row.operation, 32) ?? "",
          state: stringOf(row.state, 32) ?? "",
        });
      }
    }

    return {
      version: 1,
      role: args.role,
      runId: args.runId,
      at: new Date().toISOString(),
      requestIds: requestIdList,
      cards: cardFacts,
      contributions,
      contributionEvents,
      helpRequests,
      supervisions,
      reviewCases,
      reviewDecisions,
      acceptanceOutbox,
      piRuns,
      piEvents,
      piOriginProjections,
      piOriginEvents,
      piCommands,
      piApiRequests,
      workspaceClaims,
      workerAttempts,
      processFacts,
    };
  } finally {
    db.close();
  }
}

// ── remote-pi-control ────────────────────────────────────────────────────────

function canonicalApprovalStatement(approval: {
  approvalId: string;
  runId: string;
  originPeer: string;
  commandId: string;
  approvingPrincipal: string;
  issuedAt: string;
  expiresAt: string;
  interruptedGeneration: number;
}): string {
  return JSON.stringify({
    approval_id: approval.approvalId,
    run_id: approval.runId,
    origin_peer: approval.originPeer,
    command_id: approval.commandId,
    approving_principal: approval.approvingPrincipal,
    issued_at: approval.issuedAt,
    expires_at: approval.expiresAt,
    interrupted_generation: approval.interruptedGeneration,
  });
}

function verifyApprovalStatement(approval: {
  approvalId: string;
  runId: string;
  originPeer: string;
  commandId: string;
  approvingPrincipal: string;
  issuedAt: string;
  expiresAt: string;
  interruptedGeneration: number;
  approvalStatementSha256: string;
}): boolean {
  return createHash("sha256").update(canonicalApprovalStatement(approval), "utf-8").digest("hex")
    === approval.approvalStatementSha256;
}

function signCanonical(signingKey: string, canonical: string): string {
  const key = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  return cryptoSign(null, Buffer.from(canonical, "utf-8"), key).toString("base64");
}

function signRequestHeaders(signingKey: string, selfName: string, method: string, path: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = `abtars-req-v1\n${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  return {
    "X-Peer-Id": selfName,
    "X-Peer-Ts": ts,
    "X-Peer-Nonce": nonce,
    "X-Peer-Sig": signCanonical(signingKey, canonical),
  };
}

function spkiOfPemCert(pem: string): string {
  const key = createPublicKey({ key: pem, format: "pem" });
  return (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

function postPinned(host: string, port: number, verifyKey: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      port,
      path,
      method: "POST",
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 131_072) {
          res.destroy();
          reject(new Error("response exceeds 128 KiB"));
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", (err) => reject(err));
    req.on("secureConnect", () => {
      const cert = (req.socket as TLSSocket).getPeerCertificate();
      if (cert && cert.raw) {
        const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(cert.raw).toString("base64")}\n-----END CERTIFICATE-----`;
        if (spkiOfPemCert(pem) !== verifyKey) {
          req.destroy(new Error("peer TLS certificate does not match enrolled verify key"));
        }
      }
    });
    req.end(body);
  });
}

async function remotePiControl(args: ParsedArgs): Promise<RemoteSwarmPiControlResultV1> {
  const home = args.home;
  const peersConfig = readJsonBounded(join(home, "config", "peers.json"), 128_000);
  if (peersConfig === null) fail("NO_PEERS_CONFIG", "config/peers.json missing on requester");
  const selfBlock = peersConfig.self as Record<string, unknown> | undefined;
  const peersMap = peersConfig.peers as Record<string, unknown> | undefined;
  if (selfBlock === undefined || typeof selfBlock.name !== "string" || typeof selfBlock.signingKey !== "string") {
    fail("NO_SELF_IDENTITY", "requester self identity missing in config/peers.json");
  }
  const receiverPeer = args.command.peer;
  const receiverBlock = receiverPeer && peersMap ? peersMap[receiverPeer] as Record<string, unknown> | undefined : undefined;
  if (receiverBlock === undefined || typeof receiverBlock.host !== "string" || typeof receiverBlock.port !== "number" || typeof receiverBlock.verifyKey !== "string") {
    fail("NO_RECEIVER_ENROLLMENT", "receiver peer enrollment missing or incomplete in config/peers.json");
  }
  const pi: RemoteSwarmPiControlRequestV1 | undefined = args.command.pi;
  if (pi === undefined) fail("BAD_ARGS", "remote-pi-control requires --json pi");

  const envelope: Record<string, unknown> = {
    version: 1,
    command_id: pi.commandId,
    run_id: pi.piRunId,
    expected_generation: pi.generation,
    command: { action: pi.action },
  };
  if (pi.action === "reply") {
    if (pi.requestId === undefined) fail("BAD_ARGS", "reply requires request_id");
    envelope.command = { action: "reply", request_id: pi.requestId, value: pi.value ?? null };
  } else if (pi.action === "steer") {
    if (pi.instruction === undefined) fail("BAD_ARGS", "steer requires instruction");
    envelope.command = { action: "steer", instruction: pi.instruction };
  } else if (pi.action === "resume") {
    if (pi.approval === undefined) fail("BAD_ARGS", "resume requires approval");
    if (!verifyApprovalStatement(pi.approval)) fail("BAD_APPROVAL", "resume approval statement hash mismatch");
    envelope.command = {
      action: "resume",
      approval: {
        approval_id: pi.approval.approvalId,
        run_id: pi.approval.runId,
        origin_peer: pi.approval.originPeer,
        command_id: pi.approval.commandId,
        approving_principal: pi.approval.approvingPrincipal,
        issued_at: pi.approval.issuedAt,
        expires_at: pi.approval.expiresAt,
        interrupted_generation: pi.approval.interruptedGeneration,
        approval_statement_sha256: pi.approval.approvalStatementSha256,
      },
    };
  }

  const body = JSON.stringify(envelope);
  const path = `/v1/pi-runs/${encodeURIComponent(pi.piRunId)}/control`;
  const headers = signRequestHeaders(selfBlock.signingKey, selfBlock.name, "POST", path, body);
  let response: { status: number; body: string };
  try {
    response = await postPinned(receiverBlock.host, receiverBlock.port, receiverBlock.verifyKey, path, headers, body);
  } catch (err) {
    return {
      version: 1,
      role: "requester",
      runId: args.runId,
      action: pi.action,
      outcome: "transport_error",
      error: { code: "TRANSPORT_ERROR", message: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
      projection: null,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      version: 1,
      role: "requester",
      runId: args.runId,
      action: pi.action,
      outcome: "transport_error",
      error: { code: "HTTP_ERROR", message: `HTTP ${response.status}: ${response.body.slice(0, 500)}` },
      projection: null,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return {
      version: 1,
      role: "requester",
      runId: args.runId,
      action: pi.action,
      outcome: "transport_error",
      error: { code: "BAD_RESPONSE", message: "control response is not valid JSON" },
      projection: null,
    };
  }
  const outcome = parsed.outcome;
  if (outcome !== "succeeded" && outcome !== "rejected" && outcome !== "outcome_unknown") {
    return {
      version: 1,
      role: "requester",
      runId: args.runId,
      action: pi.action,
      outcome: "invalid_request",
      error: { code: "BAD_RESPONSE", message: `unexpected control outcome ${String(outcome)}` },
      projection: null,
    };
  }
  const projectionRaw = parsed.projection as Record<string, unknown> | undefined;
  const projection = projectionRaw === undefined ? null : {
    status: typeof projectionRaw.status === "string" ? trim(projectionRaw.status, 32) : null,
    generation: typeof projectionRaw.generation === "number" ? projectionRaw.generation : null,
    cursor: typeof projectionRaw.acknowledged_sequence === "number" ? projectionRaw.acknowledged_sequence
      : typeof projectionRaw.latest_sequence === "number" ? projectionRaw.latest_sequence : null,
    resumeCapability: typeof projectionRaw.resume_capability === "string" ? trim(projectionRaw.resume_capability, 64) : null,
  };
  const errorRaw = parsed.error as Record<string, unknown> | undefined;
  return {
    version: 1,
    role: "requester",
    runId: args.runId,
    action: pi.action,
    outcome: outcome as RemoteSwarmPiControlResultV1["outcome"],
    error: errorRaw === undefined ? null : {
      code: typeof errorRaw.code === "string" ? trim(errorRaw.code, 64) : "UNKNOWN",
      message: typeof errorRaw.message === "string" ? trim(errorRaw.message, 500) : "",
    },
    projection,
  };
}

// ── log-tail ─────────────────────────────────────────────────────────────────

function logTail(args: ParsedArgs): RemoteSwarmLogTailV1 {
  const home = args.home;
  const logsDir = join(home, "logs");
  let newest: { name: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(logsDir)) {
      if (!name.startsWith("bridge-") || !name.endsWith(".log")) continue;
      const full = join(logsDir, name);
      try {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest.mtime) newest = { name, mtime };
      } catch { /* skip unreadable */ }
    }
  } catch {
    return { version: 1, role: args.role, runId: args.runId, truncated: false, tail: "" };
  }
  if (newest === null) return { version: 1, role: args.role, runId: args.runId, truncated: false, tail: "" };
  const lines = args.command.lines ?? 200;
  try {
    const raw = readFileSync(join(logsDir, newest.name), "utf-8");
    const all = raw.split("\n");
    const slice = all.slice(Math.max(0, all.length - lines - 1));
    const truncated = all.length > lines;
    let tail = redact(slice.join("\n"));
    if (tail.length > bounds.tailBytes) tail = tail.slice(-bounds.tailBytes);
    return { version: 1, role: args.role, runId: args.runId, truncated, tail };
  } catch {
    return { version: 1, role: args.role, runId: args.runId, truncated: false, tail: "" };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  switch (args.command.command) {
    case "preflight":
      emitResult("preflight", preflight(args));
      break;
    case "snapshot":
      emitResult("snapshot", await snapshot(args));
      break;
    case "remote-pi-control":
      emitResult("control", await remotePiControl(args));
      break;
    case "log-tail":
      emitResult("log-tail", logTail(args));
      break;
  }
}

await main().catch((err) => {
  fail("PROBE_ERROR", err instanceof Error ? err.message : String(err));
});
