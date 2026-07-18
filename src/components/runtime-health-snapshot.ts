import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { abtarsHome } from "../paths.js";
import { readBridgeLockField } from "./transport/bridge-lock-transport.js";
import type { RuntimeHealthSnapshotV1, SnapshotTrust } from "../cli/commands/doctor-types.js";

const SNAPSHOT_PATH = join(abtarsHome(), "state", "runtime-health-v1.json");
const MAX_FUTURE_SKEW_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
const MAX_SNAPSHOT_AGE_SEC_MULTIPLIER = 2;
const BASE_MAX_AGE_SEC = 120;

const MAX_ROUTES = 20;
const MAX_DIRECTIONS = 2;
const MAX_ACTIVE_CARD_IDS = 1000;
const MAX_ERROR_BYTES = 500;

let _state: RuntimeHealthSnapshotV1 | null = null;

function ensureStateDir(): void {
  mkdirSync(join(abtarsHome(), "state"), { recursive: true });
}

export function initSnapshot(pid: number, startedAt: number): void {
  _state = {
    schemaVersion: 1,
    bridge: { pid, startedAt, updatedAt: Date.now() },
    peerApi: { state: "starting" },
    doorbell: { state: "starting" },
    routes: [],
    activeCardIds: [],
  };
  writeSnapshot();
}

function truncateError(err: string): string | undefined {
  let len = 0;
  for (let i = 0; i < err.length; i++) {
    len += Buffer.byteLength(err[i]!, "utf-8");
    if (len > MAX_ERROR_BYTES) return err.slice(0, i) + "…";
  }
  return err || undefined;
}

export function updatePeerApiState(state: "disabled" | "starting" | "listening" | "failed", lastError?: string): void {
  if (!_state) return;
  _state.peerApi = { state, lastError: lastError ? truncateError(lastError) : undefined };
  writeSnapshot();
}

export function updateDoorbellState(state: "disabled" | "starting" | "listening" | "degraded", lastError?: string): void {
  if (!_state) return;
  _state.doorbell = { state, lastError: lastError ? truncateError(lastError) : undefined };
  writeSnapshot();
}

export function updateRoutes(routes: RuntimeHealthSnapshotV1["routes"]): void {
  if (!_state) return;
  _state.routes = routes.slice(0, MAX_ROUTES).map(r => ({
    ...r,
    directions: r.directions.slice(0, MAX_DIRECTIONS),
  }));
  writeSnapshot();
}

export function updateActiveCardIds(ids: number[]): void {
  if (!_state) return;
  _state.activeCardIds = ids.slice(0, MAX_ACTIVE_CARD_IDS);
  writeSnapshot();
}

export function refreshSnapshot(): void {
  if (!_state) return;
  _state.bridge.updatedAt = Date.now();
  writeSnapshot();
}

function writeSnapshot(): void {
  if (!_state) return;
  ensureStateDir();
  const tmp = SNAPSHOT_PATH + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(_state));
  renameSync(tmp, SNAPSHOT_PATH);
}

export function removeSnapshot(): void {
  if (!_state) return;
  try {
    const lockPid = readBridgeLockField<number>("pid") ?? 0;
    if (lockPid === _state.bridge.pid && _state.bridge.startedAt > 0) {
      if (existsSync(SNAPSHOT_PATH)) unlinkSync(SNAPSHOT_PATH);
    }
  } catch { /* non-fatal */ }
  _state = null;
}

export function readSnapshot(): { trust: SnapshotTrust; data: RuntimeHealthSnapshotV1 | null } {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return { trust: "missing", data: null };
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    const data = JSON.parse(raw) as RuntimeHealthSnapshotV1;

    if (data.schemaVersion !== 1) return { trust: "invalid", data: null };
    if (typeof data.bridge?.pid !== "number") return { trust: "invalid", data: null };
    if (typeof data.bridge?.startedAt !== "number") return { trust: "invalid", data: null };
    if (typeof data.bridge?.updatedAt !== "number") return { trust: "invalid", data: null };
    if (!Array.isArray(data.routes)) return { trust: "invalid", data: null };
    if (!Array.isArray(data.activeCardIds)) return { trust: "invalid", data: null };

    const now = Date.now();
    if (data.bridge.updatedAt > now + MAX_FUTURE_SKEW_MS) return { trust: "stale", data };

    const lockPid = readBridgeLockField<number>("pid") ?? 0;
    if (lockPid === 0) return { trust: "wrong-process", data };
    const lockStartedAt = readBridgeLockField<number>("startedAt") ?? 0;

    if (data.bridge.pid !== lockPid || data.bridge.startedAt !== lockStartedAt) return { trust: "wrong-process", data };

    try { process.kill(lockPid, 0); } catch { return { trust: "wrong-process", data }; }

    const ageSec = (now - data.bridge.updatedAt) / 1000;
    const hbInterval = parseInt(process.env["HEARTBEAT_INTERVAL_SEC"] ?? String(DEFAULT_HEARTBEAT_INTERVAL_SEC), 10);
    const maxAge = Math.max(BASE_MAX_AGE_SEC, hbInterval * MAX_SNAPSHOT_AGE_SEC_MULTIPLIER);
    if (ageSec > maxAge) return { trust: "stale", data };

    return { trust: "trusted", data };
  } catch {
    return { trust: "invalid", data: null };
  }
}

export function getRtSnapshotState(): RuntimeHealthSnapshotV1 | null {
  return _state;
}
