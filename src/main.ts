/**
 * AgentBridge — entry point.
 * Internal restart loop: exit code 0 = restart, non-zero = die.
 *
 * CRITICAL: `./boot/env.js` MUST be the first import. ES static imports are
 * hoisted above body statements, so loading dotenv in the body runs too late —
 * transitive module-level `process.env[X]` reads freeze defaults first. The
 * bootstrap module performs the load as a side effect during its own
 * evaluation, guaranteeing it completes before any other import is processed.
 */

import "./boot/env.js";
import { initEnv, _resetEnv } from "./components/env-schema.js";
import { startBridge } from "./bridge-app.js";
import { logInfo } from "./components/logger.js";

initEnv();

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
  process.exit(1);
});

(async () => {
  while (true) {
    const code = await startBridge();
    if (code !== 0) process.exit(code);
    logInfo("main", "♻️ Bridge restart requested — restarting...");
    _resetEnv(); // re-read env on restart (config may have changed)
    initEnv();
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
