/**
 * AgentBridge — entry point.
 * Parses CLI args, starts the bridge, handles fatal errors.
 */

import { startBridge } from "./bridge-app.js";

startBridge().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
