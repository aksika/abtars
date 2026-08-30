import "./boot/env.js";
process.umask(0o077);
import { reloadSecrets } from "./boot/env.js";
import { initEnv, _resetEnv } from "./components/env-schema.js";
import { startBridge } from "./bridge-app.js";
import { logInfo, logError, flushLogs } from "./components/logger.js";
import { resetAbmindCache } from "./utils/abmind-lazy.js";
import { writeOwnedExitFields } from "./components/transport/bridge-lock-transport.js";

initEnv();

import { checkCircuitBreaker } from "./boot/circuit-breaker.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateBridgeLock, potentialHomeBridgeProcesses } from "./supervisor/identity.js";

// Duplicate-bridge gate runs BEFORE the circuit breaker: a duplicate bridge
// must exit without touching rollback counters or release links (R6).
// #1711 R3: boot follows the same zero-process rule as the watchdog — only a
// complete enumeration proving zero OTHER could-be-same-home processes
// authorizes this boot to proceed. A live process behind a corrupt lock is
// caught here even when its own lock no longer validates.
// #1711 R2.1: unattributable relative-spelled processes block loudly — the PID
// list is printed before exiting; a silent freeze is a spec violation (B13).
try {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const lockPath = join(home, "bridge.lock");
  let lock: Record<string, unknown> | null = null;
  try { lock = JSON.parse(readFileSync(lockPath, "utf-8")); } catch { /* missing */ }
  const result = validateBridgeLock(lock, ["abtars.js", "bundle"]);
  if (result.status === "valid" && lock && typeof lock.pid === "number" && lock.pid !== process.pid) {
    console.error(`[FATAL] Another bridge running (PID ${lock.pid}) — exiting`);
    process.exit(1);
  }
  const scope = potentialHomeBridgeProcesses(home);
  if (!scope.complete) {
    console.error(`[FATAL] Duplicate gate: process enumeration failed (${scope.reason}) — refusing to start`);
    process.exit(1);
  }
  const others = scope.blockers.filter((p) => p.pid !== process.pid);
  if (others.length > 0) {
    const detail = others.map((p) => `PID ${p.pid} (${p.argv.join(" ")})`).join("; ");
    console.error(`[FATAL] Another bridge process present — refusing to start: ${detail}`);
    for (const u of scope.unattributable) {
      console.error(
        `[FATAL] blocked-unattributable PID ${u.pid} (${u.argv.join(" ")}): ${u.reason} — this process predates the canonical spawn target; restart or terminate it to restore supervision`,
      );
    }
    process.exit(1);
  }
} catch (err) {
  // The duplicate gate is an authorization boundary. An unexpected read or
  // predicate failure is uncertainty, not permission to start beside a process.
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[FATAL] Duplicate gate failed closed: ${detail}`);
  process.exit(1);
}

checkCircuitBreaker();

process.on("uncaughtException", (err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT" && typeof e.syscall === "string" && e.syscall.startsWith("spawn")) {
    console.error(`[WARN] Suppressed spawn ENOENT (binary not found, bridge continues): ${e.syscall} — ${e.message}`);
    return;
  }
  // #1750: the fatal reason must survive in the bridge's own log. The logger
  // buffers, so flush synchronously — process.exit() below does not wait for
  // the buffered writer, and this must never be the thing that throws on the way out.
  try { logError("main", `FATAL uncaught exception`, err); flushLogs(); } catch { /* stderr below is the fallback */ }
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

process.on("exit", (code) => {
  const stack = new Error("exit trace").stack?.split("\n").slice(1, 6).join("\n") ?? "";
  // #1750: the fatal reason must survive in the bridge's own log. The logger
  // buffers, so flush synchronously — process.exit() below does not wait for
  // the buffered writer, and this must never be the thing that throws on the way out.
  try { logError("main", `FATAL exit code=${code}`, stack); flushLogs(); } catch { /* stderr below is the fallback */ }
  console.error(`[EXIT] code=${code} at ${new Date().toISOString()}\n${stack}`);
  try {
    // #1711 R1: exit fields are bridge-owned — written through the owner gate
    // so a non-owner process can never forge them. Warn-only; never masks exit.
    writeOwnedExitFields(code, Date.now());
  } catch { /* lock missing/corrupt — do not mask exit */ }
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const isAcpRecoverable = (reason instanceof Error && reason.name === "AcpExitError")
    || msg.includes("kiro-cli exited") || msg.includes("-32603") || msg.includes("AcpExit");
  if (isAcpRecoverable) {
    console.error(`[WARN] Suppressed ACP rejection (transport will reinit): ${msg}`);
    return;
  }
  // #1750: the fatal reason must survive in the bridge's own log. The logger
  // buffers, so flush synchronously — process.exit() below does not wait for
  // the buffered writer, and this must never be the thing that throws on the way out.
  try { logError("main", `FATAL unhandled rejection`, reason); flushLogs(); } catch { /* stderr below is the fallback */ }
  console.error(`[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
  process.exit(1);
});

(async () => {
  const supervision = process.env["SUPERVISION"];
  if (supervision) {
    logInfo("main", `🔒 Supervised by ${supervision} — internal restart loop disabled`);
    const code = await startBridge();
    process.exit(code);
  }
  while (true) {
    const code = await startBridge();
    if (code !== 0) process.exit(code);
    logInfo("main", "♻️ Bridge restart requested — restarting...");
    _resetEnv();
    reloadSecrets();
    resetAbmindCache();
    initEnv();
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
