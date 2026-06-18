/**
 * boot/circuit-breaker.ts — Auto-rollback on repeated crash loop (#1050).
 * Runs BEFORE boot graph. Only file ops — no imports from components.
 * If 4+ deaths in 7min: destroy current app, promote prev.N, exit.
 * Watchdog respawns with the new code.
 */

import { readFileSync, existsSync, rmSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const WINDOW = 420; // 7 minutes
const MAX_DEATHS = 4;

export function checkCircuitBreaker(): void {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  const stateFile = join(home, "watchdog.state");
  if (!existsSync(stateFile)) return;

  const now = Math.floor(Date.now() / 1000);
  const lines = readFileSync(stateFile, "utf-8").trim().split("\n").filter(Boolean);
  const recent = lines.filter(l => now - parseInt(l, 10) < WINDOW);

  if (recent.length < MAX_DEATHS) return;

  // Circuit breaker tripped — auto-rollback (destroy pattern)
  const appDir = join(home, "app");
  for (let slot = 1; slot <= 3; slot++) {
    const prevDir = join(home, `app.prev.${slot}`);
    if (!existsSync(prevDir)) continue;

    let commit = "unknown";
    try { commit = JSON.parse(readFileSync(join(prevDir, "package.json"), "utf-8")).version ?? "unknown"; } catch {}

    // Destroy current, promote prev
    rmSync(appDir, { recursive: true, force: true });
    renameSync(prevDir, appDir);

    // Clear state, set reason for next boot
    try { unlinkSync(stateFile); } catch {}
    writeFileSync(join(home, ".start-reason"), `auto-rollback:${slot}:${commit}`);

    console.error(`[circuit-breaker] ${recent.length} deaths in 7min — rolled back to slot ${slot} (${commit})`);
    process.exit(0); // watchdog respawns with new code
  }

  // All slots exhausted — stop
  console.error("[circuit-breaker] All rollback slots exhausted — stopping");
  try { writeFileSync(join(home, ".stopped"), ""); } catch {}
  try { unlinkSync(stateFile); } catch {}
  process.exit(1);
}
