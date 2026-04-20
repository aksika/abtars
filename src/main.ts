/**
 * AgentBridge — entry point.
 * Parses CLI args, starts the bridge, handles fatal errors.
 *
 * CRITICAL: `./boot/env.js` MUST be the first import. ES static imports are
 * hoisted above body statements, so loading dotenv in the body runs too late —
 * transitive module-level `process.env[X]` reads freeze defaults first. The
 * bootstrap module performs the load as a side effect during its own
 * evaluation, guaranteeing it completes before any other import is processed.
 */

import "./boot/env.js";
import { startBridge } from "./bridge-app.js";

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
  process.exit(1);
});

startBridge().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
