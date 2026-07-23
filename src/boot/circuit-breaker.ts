import { readFileSync, existsSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveAbtarsHome, resolveReleasesDir } from "../cli/deploy-lib/paths.js";
import { readSupervisorState, resetRestartCount } from "../supervisor/state.js";

const MAX_DEATHS = 4;

export function checkCircuitBreaker(): void {
  const home = resolveAbtarsHome();
  const releasesDir = resolveReleasesDir();
  const historyFile = join(releasesDir, "history.json");
  const currentLink = join(releasesDir, "current");
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
  try { history = JSON.parse(readFileSync(historyFile, "utf-8")); } catch {}

  if (history.length < 2) {
    console.error("[circuit-breaker] No previous release to roll back to — continuing anyway");
    resetRestartCount(home, "rollback-unavailable");
    return;
  }

  const target = history[1]!;
  const targetDir = join(releasesDir, target);
  if (!existsSync(targetDir)) {
    console.error(`[circuit-breaker] history[1] dir ${target} not found — continuing anyway`);
    resetRestartCount(home, "rollback-target-missing");
    return;
  }

  try { unlinkSync(currentLink); } catch {}
  symlinkSync(targetDir, currentLink);

  const appLink = join(home, "app");
  try { unlinkSync(appLink); } catch {}
  try { symlinkSync(targetDir, appLink); } catch {}

  resetRestartCount(home, "auto-rollback");
  console.error(`[circuit-breaker] ${restartCount} unplanned deaths — rolled back to ${target}`);
  process.exit(0);
}
