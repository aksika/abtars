import { createRequire as __creq } from 'node:module';
const require = __creq(import.meta.url);

// scripts/watchdog-acceptance/fixture-bridge.ts
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/components/logger.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join as join2 } from "node:path";

// src/paths.ts
import { resolve, join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
function abtarsHome() {
  return process.env.ABTARS_HOME ?? resolve(homedir(), ".abtars");
}
var SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// src/components/logger.ts
var LEVEL_ORDER = { off: 0, low: 1, debug: 2, trace: 3 };
var LOG_DIR = join2(abtarsHome(), "logs");
function getLogFile() {
  const d = /* @__PURE__ */ new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join2(LOG_DIR, `bridge-${date}.log`);
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
    mkdirSync(LOG_DIR, { recursive: true });
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
function logError(tag, msg, err) {
  if (!shouldLog("low")) return;
  const errStr = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err ?? "");
  const fullMsg = errStr ? `${msg} \u2014 ${errStr}` : msg;
  const safe = redactSecrets(fullMsg);
  const line = formatLine("error", tag, safe);
  if (err) {
    if (process.stdout.isTTY) console.error(`[${tag}] ${redactSecrets(msg)}`, redactSecrets(String(err)));
  } else {
    if (process.stdout.isTTY) console.error(`[${tag}] ${safe}`);
  }
  writeToFile(line);
}
function logTrace(tag, msg) {
  if (!shouldLog("trace")) return;
  const safe = redactSecrets(msg);
  const line = formatLine("trace", tag, safe);
  if (process.stdout.isTTY) console.log(`[${tag}] ${safe}`);
  writeToFile(line);
}

// src/components/log-and-swallow.ts
function logAndSwallow(tag, context, err, level = "trace") {
  const msg = `[swallowed] ${context}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`;
  if (level === "error") logError(tag, msg);
  else if (level === "warn") logWarn(tag, msg);
  else logTrace(tag, msg);
  return void 0;
}

// src/components/transport/bridge-lock-transport.ts
import { readFileSync as readFileSync2 } from "node:fs";

// src/components/atomic-write.ts
import { writeFileSync, renameSync, openSync, fchmodSync, fsyncSync, closeSync, unlinkSync, lstatSync } from "node:fs";
var TAG = "atomic-write";
var ORPHAN_TMP_STALE_MS = 3e4;
function atomicWriteSync(path, data, mode = 384) {
  const tmp = path + ".tmp";
  let fd;
  let created = false;
  try {
    try {
      fd = openSync(tmp, "wx", mode);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const ageMs = Date.now() - lstatSync(tmp).mtimeMs;
      if (ageMs < ORPHAN_TMP_STALE_MS) throw err;
      logWarn(TAG, `Removing orphan temp file from an interrupted write (age ${Math.round(ageMs / 1e3)}s): ${tmp}`);
      unlinkSync(tmp);
      fd = openSync(tmp, "wx", mode);
    }
    created = true;
    fchmodSync(fd, mode);
    writeFileSync(fd, data, { encoding: "utf-8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = void 0;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
      }
    }
    throw err;
  }
}

// src/components/transport/bridge-lock-transport.ts
import { join as join3 } from "node:path";
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

// src/components/transport/bridge-lock-transport.ts
function updateBridgeLockField(key, value) {
  const p = join3(abtarsHome(), "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync2(p, "utf-8"));
    lock[key] = value;
    atomicWriteSync(p, JSON.stringify(lock));
  } catch (err) {
    logAndSwallow("bridge_lock_transport", `updateBridgeLockField(${key}) on ${p}`, err);
  }
}
function initBridgeLock(opts) {
  const p = join3(abtarsHome(), "bridge.lock");
  let prev = { pid: null, lastHeartbeat: null };
  try {
    let existing = {};
    try {
      existing = JSON.parse(readFileSync2(p, "utf-8"));
    } catch {
    }
    const prevPid = typeof existing.pid === "number" ? existing.pid : null;
    prev = { pid: prevPid, lastHeartbeat: typeof existing.lastHeartbeat === "number" ? existing.lastHeartbeat : null };
    let bootType = "cold";
    if (prev.lastHeartbeat) {
      const gapS = (Date.now() - prev.lastHeartbeat) / 1e3;
      if (gapS < 300) bootType = "quick-restart";
      else if (gapS <= 7200) bootType = "short-outage";
      else bootType = "long-outage";
    }
    const wdPid = Number(process.env.ABTARS_WATCHDOG_PID) || existing.watchdogPid || null;
    const wdStartIdentity = typeof existing.watchdogStartIdentity === "string" ? existing.watchdogStartIdentity : typeof wdPid === "number" && wdPid > 0 ? processStartIdentity(wdPid) : null;
    const instanceId = randomUUID();
    atomicWriteSync(p, JSON.stringify({
      pid: opts.pid,
      watchdogPid: wdPid,
      watchdogStartIdentity: wdStartIdentity,
      startedAt: opts.startedAt,
      version: opts.version,
      instanceId,
      startIdentity: processStartIdentity(opts.pid),
      sleepStatus: "awake",
      argv: opts.argv,
      lastHeartbeat: Date.now(),
      startReason: opts.startReason ?? "unknown",
      bootType
    }));
  } catch (err) {
    logAndSwallow("bridge_lock_transport", `initBridgeLock on ${p}`, err, "error");
  }
  return prev;
}
function updateLastHeartbeat() {
  updateBridgeLockField("lastHeartbeat", Date.now());
}

// scripts/watchdog-acceptance/fixture-bridge.ts
var home = process.env.ABTARS_HOME ?? join4(process.env.HOME ?? "", ".abtars");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readControl() {
  try {
    return JSON.parse(readFileSync3(join4(home, "fixture-control.json"), "utf-8"));
  } catch {
    return null;
  }
}
function claimGeneration() {
  const dir = join4(home, "fixture-generation");
  mkdirSync2(dir, { recursive: true });
  for (let n = 1; n < 1e4; n++) {
    try {
      closeSync2(openSync2(join4(dir, `${n}.claim`), "wx"));
      return n;
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("generation space exhausted");
}
function writeRegistryEntry(generation, mode) {
  const dir = join4(home, "fixture-registry");
  mkdirSync2(dir, { recursive: true });
  const entry = { pid: process.pid, generation, mode: mode.mode, startedAt: Date.now() };
  const finalPath = join4(dir, `${generation > 0 ? generation : "direct"}-${process.pid}.json`);
  const tmp = `${finalPath}.tmp`;
  writeFileSync2(tmp, JSON.stringify(entry));
  renameSync2(tmp, finalPath);
}
async function main() {
  const directRaw = process.env.ABTARS_FIXTURE_DIRECT;
  const direct = directRaw ? JSON.parse(directRaw) : null;
  const control = readControl();
  const heartbeatMs = control?.heartbeatMs ?? 200;
  const generation = claimGeneration();
  const scheduled = control?.nextSpawns.find((s) => s.generation === generation);
  const mode = direct ?? scheduled ?? control?.defaultMode ?? { mode: "healthy" };
  writeRegistryEntry(generation, mode);
  const staleShaped = mode.mode === "stale" || mode.mode === "stale-ignore-term";
  const termIgnoringShaped = mode.mode === "ignore-term" || mode.mode === "stale-ignore-term";
  let heartbeatEnabled = !staleShaped && (direct ? true : control?.live.heartbeatEnabled ?? true);
  let ignoreTerm = direct ? termIgnoringShaped : control?.live.ignoreTerm ?? false;
  if (ignoreTerm) {
    process.on("SIGTERM", () => {
    });
    process.on("SIGINT", () => {
    });
  }
  const ownsLock = !["no-lock", "non-owner", "transient", "forge-exit"].includes(mode.mode);
  if (ownsLock) {
    initBridgeLock({
      pid: process.pid,
      startedAt: Date.now(),
      version: "fixture-bridge",
      argv: [process.execPath, "app/bundle/abtars.js"],
      startReason: "watchdog-respawn"
    });
    updateLastHeartbeat();
  }
  const startedAt = Date.now();
  const exitAfterMs = mode.mode === "exit" ? mode.delayMs ?? 250 : mode.mode === "exit-stale-report" ? mode.delayMs ?? 250 : null;
  let lastLivePoll = 0;
  let reported = false;
  let liveExit = null;
  function clearConsumedExit() {
    const p = join4(home, "fixture-control.json");
    try {
      const parsed = JSON.parse(readFileSync3(p, "utf-8"));
      if (parsed.live.exit === null || parsed.live.exit === void 0) return;
      const cleared = { ...parsed, live: { ...parsed.live, exit: null } };
      const tmp = `${p}.clearing`;
      writeFileSync2(tmp, JSON.stringify(cleared));
      renameSync2(tmp, p);
    } catch {
    }
  }
  while (true) {
    const now = Date.now();
    if (now - lastLivePoll >= 100) {
      lastLivePoll = now;
      const liveControl = readControl()?.live;
      if (liveControl) {
        heartbeatEnabled = !staleShaped && liveControl.heartbeatEnabled;
        if (!direct) ignoreTerm = liveControl.ignoreTerm;
        const cmd = liveControl.exit;
        if (cmd && liveExit === null) {
          liveExit = {
            code: cmd.code,
            at: Date.now() + (cmd.delayMs ?? 0),
            staleReport: cmd.staleReport === true
          };
          clearConsumedExit();
        }
      }
      if (!ownsLock && mode.mode !== "non-owner") heartbeatEnabled = false;
    }
    switch (mode.mode) {
      case "non-owner":
        updateLastHeartbeat();
        break;
      case "forge-exit":
        updateBridgeLockField("lastExitCode", mode.forgedExitCode ?? 42);
        updateBridgeLockField("lastExitAt", Date.now() - (mode.forgedExitAgeMs ?? 0));
        break;
      default:
        break;
    }
    if (ownsLock && heartbeatEnabled) updateLastHeartbeat();
    const dueScheduled = exitAfterMs !== null && now - startedAt >= exitAfterMs;
    const dueLive = liveExit !== null && now >= liveExit.at;
    if ((dueScheduled || dueLive) && !reported) {
      reported = true;
      const code = dueLive ? liveExit.code : mode.exitCode ?? 0;
      const staleShape = dueLive ? liveExit.staleReport : mode.mode === "exit-stale-report";
      if (staleShape) {
        updateBridgeLockField("lastExitCode", code);
        updateBridgeLockField("lastExitAt", Date.now() - 6e4);
      } else {
        updateBridgeLockField("lastExitCode", code);
        updateBridgeLockField("lastExitAt", Date.now());
      }
      process.exit(code);
    }
    await sleep(Math.max(50, Math.min(heartbeatMs, 100)));
  }
}
main().catch((err) => {
  process.stderr.write(`fixture-bridge fatal: ${err instanceof Error ? err.stack : String(err)}
`);
  process.exit(70);
});
