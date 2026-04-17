/**
 * phase-shutdown — boot phase 13 (final): install SIGINT/SIGTERM handlers.
 *
 * Must run last. Takes the Bridge instance (constructed earlier in startBridge
 * from ctx) so signal handlers can route to Bridge.shutdown().
 *
 * No singletons owned. No ctx writes.
 */

import type { BootCtx } from "./context.js";
import type { Bridge } from "../bridge-app.js";

export async function phaseShutdown(ctx: BootCtx, bridge: Bridge): Promise<void> {
  // Reference ctx for symmetry with other phases; handlers route to bridge.shutdown
  // (which reads its own fields; ctx → bridge sync happens upstream in startBridge).
  void ctx;
  process.on("SIGINT", () => void bridge.shutdown());
  process.on("SIGTERM", () => void bridge.shutdown());
}
