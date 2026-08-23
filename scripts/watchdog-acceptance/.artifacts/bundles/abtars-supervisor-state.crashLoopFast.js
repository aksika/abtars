import { createRequire as __creq } from 'node:module';
const require = __creq(import.meta.url);

// src/supervisor/state-cli.ts
import { resolve as resolve2, join as join4 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { readFileSync as readFileSync3 } from "node:fs";

// src/supervisor/state.ts
import { readFileSync as readFileSync2, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

// src/supervisor/identity.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
function macProcessField(pid, field) {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}
function processStartIdentity(pid) {
  if (process.platform === "darwin") {
    const startedAt = macProcessField(pid, "lstart");
    const timestamp = startedAt === null ? NaN : Date.parse(startedAt);
    return `${pid}:${Number.isFinite(timestamp) ? timestamp : 0}`;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return `${pid}:0`;
    const fields = stat.slice(rp + 2).split(" ");
    const startTime = fields[19];
    return `${pid}:${startTime ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function validateBridgePid(pid, expectedIdentity, needles) {
  const alive = isPidAlive(pid);
  if (!alive) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  if (expectedIdentity !== null) {
    const actual = processStartIdentity(pid);
    if (actual !== expectedIdentity) {
      return { status: "reused", safeToSignal: false, safeToAdopt: false };
    }
  }
  try {
    const cmdline = process.platform === "darwin" ? macProcessField(pid, "command") : readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    if (cmdline === null) {
      if (process.platform === "darwin") {
        return { status: "wrong-command", safeToSignal: false, safeToAdopt: false };
      }
      return { status: "valid", safeToSignal: true, safeToAdopt: true };
    }
    const match = needles.some((n) => cmdline.includes(n));
    if (!match) {
      return { status: "wrong-command", safeToSignal: false, safeToAdopt: false };
    }
  } catch {
    return { status: "valid", safeToSignal: true, safeToAdopt: true };
  }
  return { status: "valid", safeToSignal: true, safeToAdopt: true };
}
function validateBridgeLock(lock, needles) {
  if (lock === null || typeof lock !== "object") {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const pid = typeof lock.pid === "number" ? lock.pid : null;
  if (pid === null || pid <= 0) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  const instanceId = typeof lock.instanceId === "string" ? lock.instanceId : "";
  if (!instanceId) {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const startIdentity = typeof lock.startIdentity === "string" ? lock.startIdentity : null;
  if (startIdentity === null || process.platform !== "darwin" && startIdentity.endsWith(":0")) {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  return validateBridgePid(pid, startIdentity, needles);
}
function readBridgeLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}
function signalValidatedBridge(lockPath, signal, needles = ["abtars.js", "bundle"]) {
  const lock = readBridgeLock(lockPath);
  const result = validateBridgeLock(lock, needles);
  if (!result.safeToSignal || !lock || typeof lock.pid !== "number") return result;
  process.kill(lock.pid, signal);
  return result;
}

// src/supervisor/state.ts
var COMMAND_STALE_MS = 5 * 6e4;
var STATE_FILE = "supervisor.state";
var LOCK_DIR = ".supervisor.lock";
function defaultState() {
  return {
    schemaVersion: 1,
    desiredState: "running",
    nextCommandSeq: 1,
    pendingCommand: null,
    acknowledgedCommandSeq: 0,
    restartCount: 0,
    backoffAttempt: 0,
    recentDeaths: [],
    lastDeathAt: null
  };
}
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf-8"));
  } catch {
    return null;
  }
}
function readTextSafe(path) {
  try {
    return readFileSync2(path, "utf-8");
  } catch {
    return null;
  }
}
function writeAtomic(target, data) {
  const tmp = target + ".tmp." + randomUUID().slice(0, 8);
  writeFileSync(tmp, data, "utf-8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, target);
}
function readSupervisorState(home2) {
  const path = join(home2, STATE_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync2(path, "utf-8"));
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "missing" : "corrupt" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "corrupt" };
  }
  const pending = raw.pendingCommand;
  const nextCommandSeq = raw.nextCommandSeq;
  const acknowledgedCommandSeq = raw.acknowledgedCommandSeq;
  const restartCount = raw.restartCount;
  const backoffAttempt = raw.backoffAttempt;
  const pendingValid = pending === null || typeof pending === "object" && pending !== null && Number.isInteger(pending.seq) && typeof pending.type === "string" && typeof pending.reason === "string" && typeof pending.createdAt === "string";
  if (raw.schemaVersion !== 1 || raw.desiredState !== "running" && raw.desiredState !== "stopped" || typeof nextCommandSeq !== "number" || !Number.isInteger(nextCommandSeq) || nextCommandSeq < 1 || !pendingValid || typeof acknowledgedCommandSeq !== "number" || !Number.isInteger(acknowledgedCommandSeq) || acknowledgedCommandSeq < 0 || typeof restartCount !== "number" || !Number.isInteger(restartCount) || restartCount < 0 || typeof backoffAttempt !== "number" || !Number.isInteger(backoffAttempt) || backoffAttempt < 0 || backoffAttempt > 5 || !Array.isArray(raw.recentDeaths) || raw.recentDeaths.some((t) => typeof t !== "number" || !Number.isFinite(t)) || !(raw.lastDeathAt === null || typeof raw.lastDeathAt === "string")) {
    return { ok: false, reason: "invalid-schema" };
  }
  return { ok: true, state: raw };
}
function acquireStateLock(home2, operation, timeoutMs = 5e3) {
  const lockPath = join(home2, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    host: hostname(),
    operation,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeAtomic(join(lockPath, "owner.json"), JSON.stringify(owner));
      return {
        ok: true,
        release: () => releaseStateLock(lockPath, owner.token)
      };
    } catch {
      const existing = readJsonSafe(join(lockPath, "owner.json"));
      if (existing) {
        const alive = isPidAlive(existing.pid);
        const startOk = processStartIdentity(existing.pid) === existing.startIdentity;
        if (!alive || !startOk) {
          const tombstone = lockPath + ".stale." + randomUUID().slice(0, 8);
          try {
            renameSync(lockPath, tombstone);
            rmSync(tombstone, { recursive: true, force: true });
            continue;
          } catch {
          }
        }
      } else {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 1e3) {
            const tombstone = lockPath + ".stale." + randomUUID().slice(0, 8);
            try {
              renameSync(lockPath, tombstone);
              rmSync(tombstone, { recursive: true, force: true });
              continue;
            } catch {
            }
          }
        } catch {
        }
      }
      sleep(50);
    }
  }
  throw new Error(`Failed to acquire supervisor lock for ${operation} within ${timeoutMs}ms`);
}
function releaseStateLock(lockPath, token) {
  const owner = readJsonSafe(join(lockPath, "owner.json"));
  if (owner && owner.token === token) {
    const releasedPath = lockPath + ".released." + randomUUID().slice(0, 8);
    try {
      renameSync(lockPath, releasedPath);
    } catch {
      return;
    }
    rmSync(releasedPath, { recursive: true, force: true });
  }
}
function sleep(ms) {
  try {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
    }
  }
}
function withStateLock(home2, operation, fn) {
  const lock = acquireStateLock(home2, operation);
  try {
    const read = readSupervisorState(home2);
    if (!read.ok && read.reason !== "missing") {
      throw new Error(`Cannot mutate ${operation}: supervisor.state is ${read.reason}`);
    }
    const state = read.ok ? read.state : defaultState();
    const result = fn(state);
    writeAtomic(join(home2, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
    return result;
  } finally {
    lock.release();
  }
}
function setDesiredState(home2, desired) {
  return withStateLock(home2, `setDesiredState:${desired}`, (state) => {
    state.desiredState = desired;
    if (desired === "stopped") {
      state.pendingCommand = null;
    } else if (state.pendingCommand?.type === "stop") {
      state.pendingCommand = null;
    }
    return state;
  });
}
function publishCommand(home2, type, reason) {
  return withStateLock(home2, `publishCommand:${type}`, (state) => {
    if (type === "stop") {
      state.desiredState = "stopped";
      state.pendingCommand = null;
      return { result: "created", state };
    }
    if (state.pendingCommand) {
      if (state.pendingCommand.type === type && state.pendingCommand.reason === reason) {
        return { result: "coalesced", state };
      }
      const age = Date.now() - new Date(state.pendingCommand.createdAt).getTime();
      if (age > COMMAND_STALE_MS) {
        state.pendingCommand = null;
      } else {
        return { result: "busy", state };
      }
    }
    const seq = state.nextCommandSeq;
    state.nextCommandSeq = seq + 1;
    state.pendingCommand = {
      seq,
      type,
      reason,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (type === "stop") {
      state.desiredState = "stopped";
    }
    return { result: "created", state };
  });
}
function claimPendingCommand(home2) {
  return withStateLock(home2, "claimPendingCommand", (state) => {
    return state.pendingCommand ? { ...state.pendingCommand } : null;
  });
}
function ackCommand(home2, seq) {
  return withStateLock(home2, "ackCommand", (state) => {
    if (state.pendingCommand && state.pendingCommand.seq === seq) {
      state.pendingCommand = null;
      state.acknowledgedCommandSeq = seq;
      return true;
    }
    return false;
  });
}
function recordBridgeDeath(home2, observation) {
  return withStateLock(home2, "recordBridgeDeath", (state) => {
    state.restartCount += 1;
    state.lastDeathAt = new Date(observation.at).toISOString();
    state.recentDeaths.push(observation.at);
    if (state.recentDeaths.length > 10) {
      state.recentDeaths = state.recentDeaths.slice(-10);
    }
    state.backoffAttempt = Math.min(state.backoffAttempt + 1, 5);
    return state;
  });
}
function recordHealthyInterval(home2, now) {
  return withStateLock(home2, "recordHealthyInterval", (state) => {
    const cutoff = now - 5 * 60 * 1e3;
    state.recentDeaths = state.recentDeaths.filter((t) => t > cutoff);
    if (state.recentDeaths.length === 0) {
      state.backoffAttempt = 0;
    }
    const tenMinCutoff = now - 10 * 60 * 1e3;
    const recentTen = state.recentDeaths.filter((t) => t > tenMinCutoff);
    if (recentTen.length === 0) {
      state.restartCount = 0;
    }
    return state;
  });
}
function resetRestartCount(home2, reason) {
  return withStateLock(home2, `resetRestartCount:${reason}`, (state) => {
    state.restartCount = 0;
    state.backoffAttempt = 0;
    state.recentDeaths = [];
    state.lastDeathAt = null;
    return state;
  });
}
function getBackoffDelayMs(state) {
  const delays = [0, 120, 120, 120, 120, 120];
  const idx = Math.min(state.backoffAttempt, delays.length - 1);
  return delays[idx];
}
function migrateSupervisorState(home2) {
  const existing = readSupervisorState(home2);
  if (existing.ok) {
    return { ok: true, migrated: false };
  }
  const lock = acquireStateLock(home2, "migrate");
  try {
    const recheck = readSupervisorState(home2);
    if (recheck.ok) {
      return { ok: true, migrated: false };
    }
    let desiredState = "running";
    const stoppedFile = join(home2, ".stopped");
    if (existsSync(stoppedFile)) {
      desiredState = "stopped";
    } else {
      const startReasonPath = join(home2, ".start-reason");
      const rawReason = readTextSafe(startReasonPath)?.trim();
      const sr = rawReason?.startsWith('"') ? readJsonSafe(startReasonPath) : rawReason;
      if (sr === "stopped") {
        desiredState = "stopped";
      }
    }
    const deployStatePath = join(home2, "deploy.state");
    const deployState = readJsonSafe(deployStatePath);
    let restartCount = 0;
    let recentDeaths = [];
    let lastDeathAt = null;
    if (deployState) {
      restartCount = deployState.restartCount ?? 0;
      const dw = deployState.deathWindow;
      if (Array.isArray(dw)) {
        recentDeaths = dw;
      }
      lastDeathAt = deployState.lastDeath ?? null;
    }
    const state = {
      schemaVersion: 1,
      desiredState,
      nextCommandSeq: 1,
      pendingCommand: null,
      acknowledgedCommandSeq: 0,
      restartCount,
      backoffAttempt: 0,
      recentDeaths,
      lastDeathAt
    };
    writeAtomic(join(home2, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
    try {
      unlinkSync(stoppedFile);
    } catch {
    }
    try {
      unlinkSync(join(home2, ".start-reason"));
    } catch {
    }
    if (deployState) {
      delete deployState.restartCount;
      delete deployState.deathWindow;
      delete deployState.lastDeath;
      writeAtomic(deployStatePath, JSON.stringify(deployState, null, 2) + "\n");
    }
    return { ok: true, migrated: true };
  } finally {
    lock.release();
  }
}

// src/components/atomic-write.ts
import { writeFileSync as writeFileSync2, renameSync as renameSync2, openSync as openSync2, fchmodSync, fsyncSync as fsyncSync2, closeSync as closeSync2, unlinkSync as unlinkSync2, lstatSync } from "node:fs";

// src/components/logger.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/paths.ts
import { resolve, join as join2, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
function abtarsHome() {
  return process.env.ABTARS_HOME ?? resolve(homedir(), ".abtars");
}
var SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// src/components/logger.ts
var LEVEL_ORDER = { off: 0, low: 1, debug: 2, trace: 3 };
var LOG_DIR = join3(abtarsHome(), "logs");
function getLogFile() {
  const d = /* @__PURE__ */ new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join3(LOG_DIR, `bridge-${date}.log`);
}
var currentLevel = "low";
var isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
var fileLogging = !isTest;
function shouldLog(minLevel) {
  return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[minLevel];
}
var buffer = [];
var flushTimer = null;
function writeToFile(line) {
  if (!fileLogging) return;
  buffer.push(redactSecrets(line));
  if (buffer.length >= 200) flush();
  else if (!flushTimer) {
    flushTimer = setTimeout(flush, 3e4);
    flushTimer.unref();
  }
}
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    mkdirSync2(LOG_DIR, { recursive: true });
    appendFileSync(getLogFile(), lines.join("\n") + "\n");
  } catch {
  }
}
process.on("exit", flush);
var SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-***REDACTED***"],
  [/sk-or-[A-Za-z0-9_-]{20,}/g, "sk-or-***REDACTED***"],
  [/gsk_[A-Za-z0-9]{20,}/g, "gsk_***REDACTED***"],
  [/ghp_[A-Za-z0-9]{36,}/g, "ghp_***REDACTED***"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***REDACTED***"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox_-***REDACTED***"],
  [/AIza[A-Za-z0-9_-]{30,}/g, "AIza***REDACTED***"],
  [/AKIA[A-Z0-9]{16}/g, "AKIA***REDACTED***"],
  [/\d{8,12}:[A-Za-z0-9_-]{35,}/g, "***BOT_TOKEN***"],
  [/Bearer [A-Za-z0-9._-]{20,}/g, "Bearer ***REDACTED***"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "***JWT_REDACTED***"],
  [/hf_[A-Za-z0-9]{20,}/g, "hf_***REDACTED***"],
  [/npm_[A-Za-z0-9]{20,}/g, "npm_***REDACTED***"],
  [/sk_live_[A-Za-z0-9]{20,}/g, "sk_live_***REDACTED***"],
  [/sk_test_[A-Za-z0-9]{20,}/g, "sk_test_***REDACTED***"],
  [/SG\.[A-Za-z0-9_-]{20,}/g, "SG.***REDACTED***"],
  [/("(?:api[_-]?key|token|secret|password|authorization|credential)"\s*:\s*")[^"]{8,}"/gi, '$1***REDACTED***"'],
  [/([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)[^\s]{8,}/g, "$1***REDACTED***"]
];
function redactSecrets(text) {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function ts() {
  const d = /* @__PURE__ */ new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return isTest ? `${local} TEST` : local;
}
var logFormat = process.env["LOG_FORMAT"] === "json" ? "json" : "text";
function formatLine(level, tag, msg) {
  if (logFormat === "json") {
    return JSON.stringify({ ts: ts(), level, tag, msg });
  }
  return `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
}
function logWarn(tag, msg) {
  if (!shouldLog("low")) return;
  const safe = redactSecrets(msg);
  const line = formatLine("warn", tag, safe);
  if (process.stdout.isTTY) console.warn(`[${tag}] ${safe}`);
  writeToFile(line);
}

// src/components/atomic-write.ts
var TAG = "atomic-write";
var ORPHAN_TMP_STALE_MS = 3e4;
function atomicWriteSync(path, data, mode = 384) {
  const tmp = path + ".tmp";
  let fd;
  let created = false;
  try {
    try {
      fd = openSync2(tmp, "wx", mode);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const ageMs = Date.now() - lstatSync(tmp).mtimeMs;
      if (ageMs < ORPHAN_TMP_STALE_MS) throw err;
      logWarn(TAG, `Removing orphan temp file from an interrupted write (age ${Math.round(ageMs / 1e3)}s): ${tmp}`);
      unlinkSync2(tmp);
      fd = openSync2(tmp, "wx", mode);
    }
    created = true;
    fchmodSync(fd, mode);
    writeFileSync2(fd, data, { encoding: "utf-8" });
    fsyncSync2(fd);
    closeSync2(fd);
    fd = void 0;
    renameSync2(tmp, path);
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
    if (created) {
      try {
        unlinkSync2(tmp);
      } catch {
      }
    }
    throw err;
  }
}

// src/supervisor/state-cli.ts
var home = process.env.ABTARS_HOME ?? resolve2(homedir2(), ".abtars");
function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "read": {
      const result = readSupervisorState(home);
      if (result.ok) {
        process.stdout.write(JSON.stringify(result.state) + "\n");
        process.exit(0 /* Ok */);
      }
      process.stderr.write(result.reason + "\n");
      process.exit(2 /* Error */);
    }
    case "set-desired-state": {
      const desired = process.argv[3];
      if (desired !== "running" && desired !== "stopped") {
        process.stderr.write("Usage: supervisor-state set-desired-state <running|stopped>\n");
        process.exit(1 /* Usage */);
      }
      const state = setDesiredState(home, desired);
      process.stdout.write(JSON.stringify(state) + "\n");
      process.exit(0 /* Ok */);
    }
    case "publish-command": {
      const type = process.argv[3];
      const reason = process.argv[4];
      if (!type || !reason) {
        process.stderr.write("Usage: supervisor-state publish-command <type> <reason>\n");
        process.exit(1 /* Usage */);
      }
      const { result, state } = publishCommand(home, type, reason);
      process.stdout.write(JSON.stringify({ result, seq: state.pendingCommand?.seq ?? null }) + "\n");
      process.exit(0 /* Ok */);
    }
    case "claim-command": {
      const cmd2 = claimPendingCommand(home);
      if (cmd2) {
        process.stdout.write(`${cmd2.seq} ${cmd2.type}
`);
      } else {
        process.stdout.write("0 none\n");
      }
      process.exit(0 /* Ok */);
    }
    case "ack-command": {
      const seqStr = process.argv[3];
      if (seqStr === void 0) {
        process.stderr.write("Usage: supervisor-state ack-command <seq>\n");
        process.exit(1 /* Usage */);
      }
      const seq = parseInt(seqStr, 10);
      if (isNaN(seq)) {
        process.stderr.write("Usage: supervisor-state ack-command <seq>\n");
        process.exit(1 /* Usage */);
      }
      const ok = ackCommand(home, seq);
      process.stdout.write(ok ? "ok\n" : "mismatch\n");
      process.exit(0 /* Ok */);
    }
    case "record-death": {
      const reason = process.argv[3] ?? "unknown";
      recordBridgeDeath(home, { at: Date.now(), reason });
      process.stdout.write("ok\n");
      process.exit(0 /* Ok */);
    }
    case "record-healthy": {
      recordHealthyInterval(home, Date.now());
      process.stdout.write("ok\n");
      process.exit(0 /* Ok */);
    }
    case "reset-restart-count": {
      const reason = process.argv[3] ?? "manual";
      resetRestartCount(home, reason);
      process.stdout.write("ok\n");
      process.exit(0 /* Ok */);
    }
    case "get-backoff": {
      const read = readSupervisorState(home);
      const delay = read.ok ? getBackoffDelayMs(read.state) : 0;
      process.stdout.write(String(delay) + "\n");
      process.exit(0 /* Ok */);
    }
    case "migrate": {
      const result = migrateSupervisorState(home);
      if (result.ok) {
        process.stdout.write(result.migrated ? "migrated\n" : "noop\n");
        process.exit(0 /* Ok */);
      }
      process.stderr.write(result.error + "\n");
      process.exit(2 /* Error */);
    }
    case "desired-state": {
      const read = readSupervisorState(home);
      if (read.ok) {
        process.stdout.write(read.state.desiredState + "\n");
        process.exit(0 /* Ok */);
      }
      process.stderr.write("unavailable\n");
      process.exit(2 /* Error */);
    }
    case "is-stopped": {
      const read = readSupervisorState(home);
      if (read.ok && read.state.desiredState === "stopped") {
        process.stdout.write("yes\n");
        process.exit(0 /* Ok */);
      }
      process.stdout.write("no\n");
      process.exit(0 /* Ok */);
    }
    case "validate-bridge": {
      const lockPath = join4(home, "bridge.lock");
      let lock = null;
      try {
        lock = JSON.parse(readFileSync3(lockPath, "utf-8"));
      } catch {
      }
      const result = validateBridgeLock(lock, ["abtars.js", "bundle"]);
      const lo = lock;
      const pid = lo && typeof lo.pid === "number" ? lo.pid : 0;
      const startedAt = lo && typeof lo.startedAt === "number" ? lo.startedAt : 0;
      process.stdout.write(`${result.status} ${pid} ${startedAt}
`);
      process.exit(0 /* Ok */);
    }
    case "set-watchdog-pid": {
      const pidStr = process.argv[3];
      if (pidStr === void 0) {
        process.stderr.write("Usage: supervisor-state set-watchdog-pid <pid>\n");
        process.exit(1 /* Usage */);
      }
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) {
        process.stderr.write("Usage: supervisor-state set-watchdog-pid <pid>\n");
        process.exit(1 /* Usage */);
      }
      setBridgeWatchdogPid(home, pid);
      process.stdout.write("ok\n");
      process.exit(0 /* Ok */);
    }
    case "signal-bridge": {
      const signal = process.argv[3];
      if (signal !== "SIGTERM" && signal !== "SIGKILL" && signal !== "SIGINT") {
        process.stderr.write("Usage: supervisor-state signal-bridge <SIGTERM|SIGKILL|SIGINT>\n");
        process.exit(1 /* Usage */);
      }
      try {
        const result = signalValidatedBridge(join4(home, "bridge.lock"), signal);
        process.stdout.write(result.status + "\n");
        process.exit(0 /* Ok */);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
        process.exit(2 /* Error */);
      }
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}
`);
      process.stderr.write("Available: read, desired-state, is-stopped, set-desired-state, publish-command, claim-command, ack-command, record-death, record-healthy, reset-restart-count, get-backoff, migrate, validate-bridge, set-watchdog-pid, signal-bridge\n");
      process.exit(1 /* Usage */);
  }
}
function setBridgeWatchdogPid(home2, pid) {
  const p = join4(home2, "bridge.lock");
  let lock = {};
  try {
    lock = JSON.parse(readFileSync3(p, "utf-8"));
  } catch {
  }
  lock["watchdogPid"] = pid;
  lock["watchdogStartIdentity"] = processStartIdentity(pid);
  atomicWriteSync(p, JSON.stringify(lock));
}
main();
