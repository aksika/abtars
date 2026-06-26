/**
 * boot/circuit-breaker.ts — Auto-rollback on repeated crash loop (#1085/#1089).
 * Runs BEFORE boot graph. Only file ops — no imports from components.
 * If restartCount >= 4 AND reason is unplanned: repoint current symlink to history[1].
 * Planned restarts (update/user-restart/rollback) reset the counter.
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const MAX_DEATHS = 4;

export function checkCircuitBreaker(): void {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const releasesDir = resolve(homedir(), ".abtars-releases");
  const stateFile = join(home, "deploy.state");
  const historyFile = join(releasesDir, "history.json");
  const currentLink = join(releasesDir, "current");
  const reason = process.env["ABTARS_START_REASON"] ?? "watchdog-respawn";

  // Planned restart — reset counter and proceed
  if (reason.startsWith("update:") || reason === "user-restart" || reason.startsWith("rollback:") || reason.startsWith("auto-rollback:")) {
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

  // Circuit breaker tripped — rollback via history.json
  let history: string[] = [];
  try { history = JSON.parse(readFileSync(historyFile, "utf-8")); } catch {}

  if (history.length < 2) {
    console.error("[circuit-breaker] No previous release to roll back to — continuing anyway");
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      state.restartCount = 0;
      writeFileSync(stateFile, JSON.stringify(state) + "\n");
    } catch {}
    return;
  }

  const target = history[1]!; // prev.1
  const targetDir = join(releasesDir, target);
  if (!existsSync(targetDir)) {
    console.error(`[circuit-breaker] history[1] dir ${target} not found — continuing anyway`);
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      state.restartCount = 0;
      writeFileSync(stateFile, JSON.stringify(state) + "\n");
    } catch {}
    return;
  }

  // Repoint current symlink to prev release
  try { unlinkSync(currentLink); } catch {}
  symlinkSync(targetDir, currentLink);

  // Also repoint legacy app/ symlink
  const appLink = join(home, "app");
  try { unlinkSync(appLink); } catch {}
  try { symlinkSync(targetDir, appLink); } catch {}

  // Reset counter
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    state.restartCount = 0;
    writeFileSync(stateFile, JSON.stringify(state) + "\n");
  } catch {}

  console.error(`[circuit-breaker] ${restartCount} unplanned deaths — rolled back to ${target}`);
  process.exit(0); // WD respawns with rolled-back code
}
