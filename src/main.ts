/**
 * AgentBridge — entry point.
 * Parses CLI args, starts the bridge, handles fatal errors.
 */

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
