/**
 * boot/circuit-breaker.ts — Auto-rollback on repeated crash loop (#1085).
 * Runs BEFORE boot graph. Only file ops — no imports from components.
 * If restartCount >= 4 AND reason is unplanned (watchdog-respawn): rollback.
 * Planned restarts (update/user-restart) reset the counter.
 */

import { readFileSync, existsSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_DEATHS = 4;

export function checkCircuitBreaker(): void {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const stateFile = join(home, "deploy.state");
  const reason = process.env["ABTARS_START_REASON"] ?? "watchdog-respawn";

  // Planned restart — reset counter and proceed
  if (reason.startsWith("update:") || reason === "user-restart" || reason.startsWith("rollback:")) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      state.restartCount = 0;
      writeFileSync(stateFile, JSON.stringify(state) + "\n");
    } catch {}
    return;
  }

  // Unplanned restart — check counter
  let restartCount = 0;
  try {
    restartCount = JSON.parse(readFileSync(stateFile, "utf-8")).restartCount ?? 0;
  } catch {}

  if (restartCount < MAX_DEATHS) return;

  // Circuit breaker tripped — rollback
  const appDir = join(home, "app");
  const prevDir = join(home, "app.prev");
  if (!existsSync(prevDir)) {
    console.error("[circuit-breaker] No app.prev/ to roll back to — continuing anyway");
    // Reset counter to avoid retriggering on next boot
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      state.restartCount = 0;
      writeFileSync(stateFile, JSON.stringify(state) + "\n");
    } catch {}
    return;
  }

  let commit = "unknown";
  try { commit = JSON.parse(readFileSync(join(prevDir, "package.json"), "utf-8")).version ?? "unknown"; } catch {}

  rmSync(appDir, { recursive: true, force: true });
  renameSync(prevDir, appDir);

  // Reset counter, set reason
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    state.restartCount = 0;
    writeFileSync(stateFile, JSON.stringify(state) + "\n");
  } catch {}
  writeFileSync(join(home, ".start-reason"), `auto-rollback:${commit}`);

  console.error(`[circuit-breaker] ${restartCount} unplanned deaths — rolled back to prev/ (${commit})`);
  process.exit(0); // WD respawns with rolled-back code
}
