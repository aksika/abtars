import { logAndSwallow } from "./log-and-swallow.js";
/**
 * Platform-specific wake classification.
 * Detects whether a resume from sleep is a background wake (darkwake) or full user wake.
 *
 * #1321: hardware sleep is gone. This module retains only general standby
 * detection for non-bridge-initiated sleeps (lid close, OS idle) used by the
 * heartbeat resume handler — it no longer classifies a bridge-owned sleep window.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

/** #1265: WSL detection — cached at module load since the platform never changes at runtime.
 *  WSL kernels append "microsoft" or "WSL" to /proc/version. */
let _isWslCache: boolean | null = null;
export function isWsl(): boolean {
  if (_isWslCache !== null) return _isWslCache;
  try {
    const version = readFileSync("/proc/version", "utf-8").toLowerCase();
    _isWslCache = version.includes("microsoft") || version.includes("wsl");
  } catch {
    _isWslCache = false;
  }
  return _isWslCache;
}

/** #1265: Standby gap threshold for WSL. Below 3h = host-sleep freeze (survived, no restart).
 *  Above 3h = network state likely stale (DNS, TCP keepalives), restart is justified. */
export const WSL_STANDBY_THRESHOLD_MS = 180 * 60 * 1000;

export type ResumeKind = "dark" | "full" | "unknown";

/** Classify the current wake state. Fast, non-throwing. */
export function classifyResume(): ResumeKind {
  // OS-specific detection for non-bridge-initiated sleeps (lid close, idle).
  const os = platform();
  if (os === "darwin") return classifyMacOS();
  if (os === "linux") return classifyLinux();
  return "unknown";
}

function classifyMacOS(): ResumeKind {
  try {
    const out = execSync("pmset -g log 2>/dev/null", { timeout: 3000, encoding: "utf-8" });
    const lines = out.split("\n").filter(l => /\bDarkWake\b|\bWake\b/.test(l) && !l.includes("Notification"));
    const last = lines.at(-1) ?? "";
    if (last.includes("DarkWake")) return "dark";
    if (last.includes("Wake")) return "full";
  } catch (err) { logAndSwallow("platform_detect", "op", err); }
  return "unknown";
}

function classifyLinux(): ResumeKind {
  try {
    // Check if systemd logged a suspend resume within the last 5 minutes.
    // Linux has no darkwake — any suspend resume is a full wake.
    const out = execSync(
      "journalctl -b -u systemd-suspend.service --since '5 min ago' --no-pager -q 2>/dev/null",
      { timeout: 3000, encoding: "utf-8" },
    );
    if (out.trim().length > 0) return "full";
  } catch (err) { logAndSwallow("platform_detect", "op", err); }
  return "unknown";
}
