/**
 * peer-health.ts — Unified signed peer-health store (#1360).
 *
 * Transport-neutral status collection, Ed25519 signing, source-aware
 * observation merge, capability registry, and routing API.
 *
 * All mutation goes through ingestObservation().  UDP gossip and WSS
 * status use the same typed schema and merge rules.
 */

import { createHash, randomUUID } from "node:crypto";
import { cpus, loadavg } from "node:os";
import { loadPeerConfig } from "../peer-config.js";
import { logInfo, logDebug, logWarn, logTrace } from "../logger.js";

const TAG = "peer-health";

// ── Bounds ───────────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_PEER_CHARS = 128;
const MAX_VERSION_CHARS = 64;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_CHARS = 64;
const MAX_SESSIONS = 10_000;
const MAX_EPOCH_CHARS = 64;
const MAX_PAST_AGE_SEC = 90;
const MAX_FUTURE_SKEW_SEC = 30;
const MAX_OBSERVATIONS_PER_PEER = 8;
const TTL_MS = 180_000;
const DOMAIN_PREFIX = "abtars-peer-status-v1\n";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PeerStatusPayloadV1 {
  version: 1;
  peer: string;
  sentAt: number;
  epoch: string;
  sequence: number;
  load: number;
  sessions: number;
  abtarsVersion: string;
  capabilities: string[];
}

export interface SignedPeerStatusV1 {
  payload: string;
  signature: string;
}

export type HealthSource = "udp" | "wss";

export interface SourceObservation {
  source: HealthSource;
  receivedAt: number;
  senderTime: number;
  epoch: string;
  sequence: number;
  snapshot: PeerStatusPayloadV1;
  fingerprint: string;
}

export interface PeerHealthRecord {
  name: string;
  observations: Partial<Record<HealthSource, SourceObservation>>;
  configuredHost: string;
  configuredPort: number;
}

export interface PeerRoutingHealth {
  name: string;
  lastSeen: number;
  load: number;
  sessions: number;
  capabilities: string[];
  version: string;
  alive: boolean;
  host: string;
  port: number;
  source: HealthSource | null;
  sourceAge: number;
}

type IngestResult =
  | { ok: true }
  | { ok: false; reason: "oversized" | "bad_json" | "bad_schema" | "self" | "unknown_peer" | "bad_signature" | "stale" | "future" | "identity_mismatch" | "replay_source" | "replay_epoch" | "out_of_sequence" };

// ── Per-peer process watermark ───────────────────────────────────────────────

interface EpochWatermark {
  epoch: string;
  sentAt: number;
  sequence: number;
}

interface PeerReplayState {
  watermark: EpochWatermark | null;
  seenFingerprints: Map<string, number>;
  superseededEpochs: Map<string, number>;
}

function pruneSuperseededEpochs(rs: PeerReplayState): void {
  const now = Date.now();
  for (const [epoch, expiry] of rs.superseededEpochs) {
    if (now > expiry) rs.superseededEpochs.delete(epoch);
  }
}

function pruneStaleFingerprints(rs: PeerReplayState): void {
  const now = Date.now();
  for (const [fp, expiry] of rs.seenFingerprints) {
    if (now > expiry) rs.seenFingerprints.delete(fp);
  }
}

// ── Capability registry ──────────────────────────────────────────────────────

interface CapabilityOwner {
  generation: number;
  values: string[];
  healthy: boolean;
}

export class CapabilityRegistry {
  private owners = new Map<string, CapabilityOwner>();
  private nextGen = 1;

  register(owner: string, values: string[]): () => void {
    const gen = this.nextGen++;
    this.owners.set(owner, { generation: gen, values: [...values], healthy: true });
    const disposer = (): void => {
      const current = this.owners.get(owner);
      if (current && current.generation === gen) {
        this.owners.delete(owner);
      }
    };
    return disposer;
  }

  setHealth(owner: string, healthy: boolean): void {
    const entry = this.owners.get(owner);
    if (entry) entry.healthy = healthy;
  }

  getValues(): string[] {
    const result: string[] = [];
    for (const entry of this.owners.values()) {
      if (entry.healthy) result.push(...entry.values);
    }
    result.sort();
    const seen = new Set<string>();
    return result.filter(c => { const d = seen.has(c); seen.add(c); return !d; }).slice(0, MAX_CAPABILITIES);
  }
}

// ── Schema validation ────────────────────────────────────────────────────────

function isValidCapability(cap: string): boolean {
  if (typeof cap !== "string") return false;
  if (cap.length === 0 || cap.length > MAX_CAPABILITY_CHARS) return false;
  if (!/^[a-z][a-z0-9_.:\-]{0,63}$/.test(cap)) return false;
  if (cap.includes("..") || cap.includes("//") || cap.includes("\\\\")) return false;
  return true;
}

function validatePayload(parsed: Record<string, unknown>): PeerStatusPayloadV1 {
  if (parsed.version !== 1) throw new Error("bad_schema");

  const peer = parsed.peer;
  if (typeof peer !== "string" || peer.length === 0 || peer.length > MAX_PEER_CHARS) throw new Error("bad_schema");

  const sentAt = parsed.sentAt;
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt) || sentAt <= 0 || !Number.isSafeInteger(sentAt)) throw new Error("bad_schema");

  const epoch = parsed.epoch;
  if (typeof epoch !== "string" || epoch.length === 0 || epoch.length > MAX_EPOCH_CHARS) throw new Error("bad_schema");

  const sequence = parsed.sequence;
  if (typeof sequence !== "number" || !Number.isFinite(sequence) || sequence < 0 || !Number.isSafeInteger(sequence)) throw new Error("bad_schema");

  const load = parsed.load;
  if (typeof load !== "number" || !Number.isFinite(load) || load < 0 || load > 1) throw new Error("bad_schema");

  const sessions = parsed.sessions;
  if (typeof sessions !== "number" || !Number.isFinite(sessions) || sessions < 0 || sessions > MAX_SESSIONS || !Number.isSafeInteger(sessions)) throw new Error("bad_schema");

  const abtarsVersion = parsed.abtarsVersion;
  if (typeof abtarsVersion !== "string" || abtarsVersion.length > MAX_VERSION_CHARS) throw new Error("bad_schema");

  const capabilities = parsed.capabilities;
  if (!Array.isArray(capabilities)) throw new Error("bad_schema");
  if (capabilities.length > MAX_CAPABILITIES) throw new Error("bad_schema");
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap !== "string" || !isValidCapability(cap)) throw new Error("bad_schema");
    if (seen.has(cap)) throw new Error("bad_schema");
    seen.add(cap);
  }

  return { version: 1, peer, sentAt, epoch, sequence, load, sessions, abtarsVersion, capabilities: [...capabilities] };
}

// ── Signing helpers ──────────────────────────────────────────────────────────

function importPrivKey(signingKey: string): any {
  const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
  return createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
}

function importPubKey(verifyKey: string): any {
  const { createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  return createPublicKey({ key: Buffer.from(verifyKey, "base64"), format: "der", type: "spki" });
}

export function signStatusPayload(payload: string, signingKey: string): string {
  const { sign: cryptoSign } = require("node:crypto") as typeof import("node:crypto");
  return cryptoSign(null, Buffer.from(DOMAIN_PREFIX + payload, "utf-8"), importPrivKey(signingKey)).toString("base64");
}

export function verifyStatusSignature(payload: string, signature: string, verifyKey: string): boolean {
  const { verify: cryptoVerify } = require("node:crypto") as typeof import("node:crypto");
  try {
    return cryptoVerify(null, Buffer.from(DOMAIN_PREFIX + payload, "utf-8"), importPubKey(verifyKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// ── Observation store ────────────────────────────────────────────────────────

export class PeerHealthStore {
  private peers = new Map<string, PeerHealthRecord>();
  private replayStates = new Map<string, PeerReplayState>();
  readonly capabilities = new CapabilityRegistry();

  private getReplayState(peer: string): PeerReplayState {
    let rs = this.replayStates.get(peer);
    if (!rs) {
      rs = { watermark: null, seenFingerprints: new Map(), superseededEpochs: new Map() };
      this.replayStates.set(peer, rs);
    }
    return rs;
  }

  /** Reset all replay state (for tests). */
  resetReplayState(): void {
    this.replayStates.clear();
  }

  // ── Ingestion ────────────────────────────────────────────────────────────

  ingestSignedStatus(
    source: HealthSource,
    peerName: string,
    envelope: SignedPeerStatusV1,
  ): IngestResult {
    // 1. Size bound
    if (envelope.payload.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: "oversized" };
    if (envelope.signature.length > 512) return { ok: false, reason: "oversized" };

    // 2. Parse payload
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(envelope.payload); } catch { return { ok: false, reason: "bad_json" }; }

    // 3. Schema validate
    let payload: PeerStatusPayloadV1;
    try { payload = validatePayload(parsed); } catch { return { ok: false, reason: "bad_schema" }; }

    // 4. Self-check
    const config = loadPeerConfig();
    if (payload.peer === config.self.name) return { ok: false, reason: "self" };

    // 5. Identity match — peerName from authenticated connection must match signed identity
    if (payload.peer !== peerName) return { ok: false, reason: "identity_mismatch" };

    // 6. Verify peer is known
    const peerEntry = config.peers[peerName];
    if (!peerEntry?.verifyKey) return { ok: false, reason: "unknown_peer" };

    // 7. Ed25519 signature verify
    if (!verifyStatusSignature(envelope.payload, envelope.signature, peerEntry.verifyKey)) {
      return { ok: false, reason: "bad_signature" };
    }

    // 8. Timestamp bounds
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.sentAt < nowSec - MAX_PAST_AGE_SEC) return { ok: false, reason: "stale" };
    if (payload.sentAt > nowSec + MAX_FUTURE_SKEW_SEC) return { ok: false, reason: "future" };

    // 9. Epoch/sequence watermark and replay (source-aware fingerprint)
    const fp = createHash("sha256").update(source + "|" + envelope.payload + envelope.signature).digest("hex");
    const rs = this.getReplayState(peerName);
    pruneSuperseededEpochs(rs);
    pruneStaleFingerprints(rs);

    if (rs.seenFingerprints.has(fp)) return { ok: false, reason: "replay_source" };

    if (rs.watermark) {
      if (payload.epoch === rs.watermark.epoch) {
        if (payload.sequence < rs.watermark.sequence) return { ok: false, reason: "out_of_sequence" };
      } else {
        if (rs.superseededEpochs.has(payload.epoch)) return { ok: false, reason: "replay_epoch" };
        if (payload.sentAt <= rs.watermark.sentAt) return { ok: false, reason: "out_of_sequence" };
      }
    }

    // 10. Accept — commit fingerprints (source-aware) and watermark
    rs.seenFingerprints.set(fp, Date.now() + TTL_MS);
    if (rs.seenFingerprints.size > MAX_OBSERVATIONS_PER_PEER) {
      const oldest = rs.seenFingerprints.entries().next();
      if (oldest.value) rs.seenFingerprints.delete(oldest.value[0]);
    }

    // Track superseeded epoch
    if (rs.watermark && payload.epoch !== rs.watermark.epoch) {
      rs.superseededEpochs.set(rs.watermark.epoch, Date.now() + TTL_MS);
    }

    if (!rs.watermark || payload.epoch !== rs.watermark.epoch || payload.sequence > rs.watermark.sequence) {
      rs.watermark = { epoch: payload.epoch, sentAt: payload.sentAt, sequence: payload.sequence };
    }

    // 11. Store observation
    const observation: SourceObservation = {
      source,
      receivedAt: Date.now(),
      senderTime: payload.sentAt * 1000,
      epoch: payload.epoch,
      sequence: payload.sequence,
      snapshot: payload,
      fingerprint: fp,
    };

    let record = this.peers.get(peerName);
    if (!record) {
      const entry = config.peers[peerName];
      record = {
        name: peerName,
        observations: {},
        configuredHost: entry?.host ?? "",
        configuredPort: entry?.port ?? 0,
      };
      this.peers.set(peerName, record);
    }
    record.observations[source] = observation;

    if (!record.observations["udp"] || !record.observations["wss"]) {
      logDebug(TAG, `PEER_HEALTH ${peerName} via ${source} [${payload.capabilities.join(",")}]`);
    }

    return { ok: true };
  }

  // ── Query ────────────────────────────────────────────────────────────────

  getPeerTable(includeAll = false): PeerRoutingHealth[] {
    const now = Date.now();
    const result: PeerRoutingHealth[] = [];

    for (const record of this.peers.values()) {
      const merged = this.mergeObservations(record, now);
      if (includeAll || merged.alive) result.push(merged);
    }

    return result;
  }

  getAlivePeers(): PeerRoutingHealth[] {
    return this.getPeerTable(false);
  }

  findCapablePeer(requires: string[]): PeerRoutingHealth | null {
    const alive = this.getPeerTable(false).filter(p =>
      requires.every(req => p.capabilities.includes(req))
    );
    if (alive.length === 0) return null;
    alive.sort((a, b) => a.load - b.load);
    return alive[0]!;
  }

  /** Get the raw peer record (for diagnostics). */
  getRecord(name: string): PeerHealthRecord | undefined {
    return this.peers.get(name);
  }

  // ── Merge logic ──────────────────────────────────────────────────────────

  private mergeObservations(record: PeerHealthRecord, now: number): PeerRoutingHealth {
    const ttlMs = TTL_MS;
    let bestObs: SourceObservation | null = null;
    let bestSource: HealthSource | null = null;

    for (const source of ["udp", "wss"] as HealthSource[]) {
      const obs = record.observations[source];
      if (!obs) continue;
      if (now - obs.receivedAt > ttlMs) continue;

      if (!bestObs) {
        bestObs = obs;
        bestSource = source;
        continue;
      }

      const cmp = this.compareSnapshots(obs, bestObs);
      if (cmp > 0) {
        bestObs = obs;
        bestSource = source;
      } else if (cmp === 0 && source === "wss") {
        bestObs = obs;
        bestSource = source;
      }
    }

    const alive = bestObs !== null;
    const snapshot = bestObs?.snapshot;

    return {
      name: record.name,
      lastSeen: bestObs?.receivedAt ?? 0,
      load: snapshot?.load ?? 0,
      sessions: snapshot?.sessions ?? 0,
      capabilities: snapshot?.capabilities ?? [],
      version: snapshot?.abtarsVersion ?? "?",
      alive,
      host: record.configuredHost,
      port: record.configuredPort,
      source: bestSource,
      sourceAge: bestObs ? Math.round((now - bestObs.receivedAt) / 1000) : -1,
    };
  }

  private compareSnapshots(a: SourceObservation, b: SourceObservation): number {
    if (a.epoch === b.epoch) {
      return a.sequence - b.sequence;
    }
    return a.senderTime - b.senderTime;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  expireStale(): void {
    const now = Date.now();
    const ttlMs = TTL_MS;
    for (const [name, record] of this.peers) {
      for (const source of ["udp", "wss"] as HealthSource[]) {
        const obs = record.observations[source];
        if (obs && now - obs.receivedAt > ttlMs) {
          delete record.observations[source];
        }
      }
      if (!record.observations["udp"] && !record.observations["wss"]) {
        this.peers.delete(name);
      }
    }
  }

  get size(): number { return this.peers.size; }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: PeerHealthStore | null = null;

export function getHealthStore(): PeerHealthStore {
  if (!_instance) _instance = new PeerHealthStore();
  return _instance;
}

export function resetHealthStore(): void {
  _instance = null;
  _epoch = null;
  _sequence = 0;
}

// ── Local snapshot builder ──────────────────────────────────────────────────

let _epoch: string | null = null;
let _sequence = 0;

function getEpoch(): string {
  if (!_epoch) _epoch = randomUUID();
  return _epoch;
}

export function getLocalSnapshot(): PeerStatusPayloadV1 {
  _sequence++;
  const config = loadPeerConfig();
  const cores = cpus().length || 1;
  const load = Math.min(1, loadavg()[0]! / cores);
  const store = getHealthStore();

  let version: string;
  try {
    const pkg = require("../../../package.json") as { version?: string };
    version = pkg.version ?? "?";
  } catch {
    version = process.env["npm_package_version"] ?? "?";
  }

  let sessions = 0;
  try {
    const { spin } = require("../spin.js") as typeof import("../spin.js");
    sessions = spin.listAllSessions().filter((s: any) => !s.ended).length;
  } catch {}

  const rawCaps = store.capabilities.getValues();
  const caps = [...new Set(rawCaps)].sort().slice(0, MAX_CAPABILITIES);

  return {
    version: 1,
    peer: config.self.name,
    sentAt: Math.floor(Date.now() / 1000),
    epoch: getEpoch(),
    sequence: _sequence,
    load: Math.round(load * 100) / 100,
    sessions,
    abtarsVersion: version,
    capabilities: caps,
  };
}

export function buildSignedStatus(signingKey: string): SignedPeerStatusV1 {
  const snapshot = getLocalSnapshot();
  const payload = JSON.stringify(snapshot);
  const signature = signStatusPayload(payload, signingKey);
  return { payload, signature };
}
