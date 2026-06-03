/**
 * Abtars — entry point.
 * Internal restart loop: exit code 0 = restart, non-zero = die.
 * Under SUPERVISION (supervised-daemon mode), the loop is disabled —
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
import { initEnv, _resetEnv } from "./components/env-schema.js";
import { startBridge } from "./bridge-app.js";
import { logInfo } from "./components/logger.js";
import { resetAbmindCache } from "./utils/abmind-lazy.js";

initEnv();

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
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
    resetAbmindCache();
    initEnv();
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
