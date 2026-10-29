import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAbtarsHome, resolveReleasesDir } from "../cli/deploy-lib/paths.js";
import { readSupervisorState, resetRestartCount } from "../supervisor/state.js";
import { activateRelease } from "../cli/deploy-lib/activate.js";
import { logAndSwallow } from "../components/log-and-swallow.js";

const MAX_DEATHS = 4;

export function checkCircuitBreaker(): void {
  const home = resolveAbtarsHome();
  const releasesDir = resolveReleasesDir();
  const historyFile = join(releasesDir, "history.json");
  const reason = process.env["ABTARS_START_REASON"] ?? "watchdog-respawn";

  if (reason.startsWith("update:") || reason === "user-restart" || reason.startsWith("rollback:") || reason.startsWith("auto-rollback:")) {
    resetRestartCount(home, reason);
    return;
  }

  const read = readSupervisorState(home);
  let restartCount = 0;
  if (read.ok) {
    restartCount = read.state.restartCount;
  }

  if (restartCount < MAX_DEATHS) return;

  let history: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyFile, "utf-8"));
    if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
      throw new Error("release history must be an array of strings");
    }
    history = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[circuit-breaker] Cannot read release history (${message.slice(-300)}) — automatic rollback unavailable`);
  }

  if (history.length < 2) {
    console.error("[circuit-breaker] No previous release to roll back to — continuing anyway");
    resetRestartCount(home, "rollback-unavailable");
    try { writeFileSync(join(home, "rollback-history-missing"), new Date().toISOString() + "\n"); } catch (err) { logAndSwallow("circuit-breaker", "record rollback-history-missing marker", err); }
    return;
  }

  const target = history[1]!;
  const targetDir = join(releasesDir, target);
  if (!existsSync(targetDir)) {
    console.error(`[circuit-breaker] history[1] dir ${target} not found — continuing anyway`);
    resetRestartCount(home, "rollback-target-missing");
    try { writeFileSync(join(home, "rollback-target-missing"), new Date().toISOString() + " " + target + "\n"); } catch (err) { logAndSwallow("circuit-breaker", "record rollback-target-missing marker", err); }
    return;
  }

  // Atomically repoint canonical `current` (temp symlink → rename) and
  // normalize `app` → `current`. Shared with deploy/rollback (#1262 R7.5).
  activateRelease(releasesDir, home, targetDir);

  resetRestartCount(home, "auto-rollback");
  console.error(`[circuit-breaker] ${restartCount} unplanned deaths — rolled back to ${target}`);
  process.exit(0);
}
