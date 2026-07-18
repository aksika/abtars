/**
 * Abtars — entry point.
 * Internal restart loop: exit code 0 = restart, non-zero = die.
 * Under DAEMON mode, the loop is disabled —
 * the system supervisor (systemd/launchd) handles restarts.
 *
 * CRITICAL: `./boot/env.js` MUST be the first import. ES static imports are
 * hoisted above body statements, so loading dotenv in the body runs too late —
 * transitive module-level `process.env[X]` reads freeze defaults first. The
 * bootstrap module performs the load as a side effect during its own
 * evaluation, guaranteeing it completes before any other import is processed.
 */

import "./boot/env.js";
process.umask(0o077); // #441: all runtime files 600, dirs 700
import { reloadSecrets } from "./boot/env.js";
import { initEnv, _resetEnv } from "./components/env-schema.js";
import { startBridge } from "./bridge-app.js";
import { logInfo } from "./components/logger.js";
import { resetAbmindCache } from "./utils/abmind-lazy.js";

initEnv();

// #1050: Auto-rollback on crash loop — runs before anything else (just file ops)
import { checkCircuitBreaker } from "./boot/circuit-breaker.js";
checkCircuitBreaker();

// #1050: Prevent duplicate bridge instances
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
try {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const lock = JSON.parse(readFileSync(join(home, "bridge.lock"), "utf-8"));
  if (lock.pid && lock.pid !== process.pid) {
    process.kill(lock.pid, 0); // throws if dead
    console.error(`[FATAL] Another bridge running (PID ${lock.pid}) — exiting`);
    process.exit(1);
  }
} catch { /* lock missing, corrupt, or PID dead — proceed */ }

process.on("uncaughtException", (err) => {
  // Narrow guard: spawn ENOENT means a child-process binary was not found.
  // The child failing to start is non-fatal — log and continue (#1281).
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT" && typeof e.syscall === "string" && e.syscall.startsWith("spawn")) {
    console.error(`[WARN] Suppressed spawn ENOENT (binary not found, bridge continues): ${e.syscall} — ${e.message}`);
    return;
  }
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

process.on("exit", (code) => {
  const stack = new Error("exit trace").stack?.split("\n").slice(1, 6).join("\n") ?? "";
  console.error(`[EXIT] code=${code} at ${new Date().toISOString()}\n${stack}`);
  // #1328: self-report the real exit code into bridge.lock — the external watchdog's
  // `wait $PID` always reports 0 due to `disown` (kept intentionally for #1050 survival +
  // SIGTERM/INT-trap isolation, see resilience.asbuilt.md). Synchronous write only —
  // process.on("exit") permits no async work. Never throw: a failed lock write during
  // shutdown must not mask or alter the exit itself.
  try {
    const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
    const lockPath = join(home, "bridge.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    lock.lastExitCode = code;
    lock.lastExitAt = Date.now();
    writeFileSync(lockPath, JSON.stringify(lock));
  } catch { /* lock missing/corrupt during exit — do not mask the exit */ }
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const isAcpRecoverable = (reason instanceof Error && reason.name === "AcpExitError")
    || msg.includes("kiro-cli exited") || msg.includes("-32603") || msg.includes("AcpExit");
  if (isAcpRecoverable) {
    console.error(`[WARN] Suppressed ACP rejection (transport will reinit): ${msg}`);
    return;
  }
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
