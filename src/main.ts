import "./boot/env.js";
process.umask(0o077);
import { reloadSecrets } from "./boot/env.js";
import { initEnv, _resetEnv } from "./components/env-schema.js";
import { startBridge } from "./bridge-app.js";
import { logInfo } from "./components/logger.js";
import { resetAbmindCache } from "./utils/abmind-lazy.js";

initEnv();

import { checkCircuitBreaker } from "./boot/circuit-breaker.js";
checkCircuitBreaker();

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateBridgeLock } from "./supervisor/identity.js";

try {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const lockPath = join(home, "bridge.lock");
  let lock: Record<string, unknown> | null = null;
  try { lock = JSON.parse(readFileSync(lockPath, "utf-8")); } catch { /* missing */ }
  const result = validateBridgeLock(lock, ["abtars", "main.js", "bundle"]);
  if (result.status === "valid" && lock && typeof lock.pid === "number" && lock.pid !== process.pid) {
    console.error(`[FATAL] Another bridge running (PID ${lock.pid}) — exiting`);
    process.exit(1);
  }
} catch { /* proceed */ }

process.on("uncaughtException", (err) => {
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
  try {
    const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
    const lockPath = join(home, "bridge.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    lock.lastExitCode = code;
    lock.lastExitAt = Date.now();
    writeFileSync(lockPath, JSON.stringify(lock));
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
