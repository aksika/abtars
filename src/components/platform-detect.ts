import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
/**
 * Platform-specific wake classification.
 * Detects whether a resume from sleep is a background wake (darkwake) or full user wake.
 *
 * Primary path: if bridge.lock.sleepStatus === "hw_sleep" (we put the machine to sleep),
 * use the sleep window to classify — inside window = dark (suppress), outside = full (morning restart).
 * No OS-specific parsing needed for the common case.
 *
 * Fallback: OS-specific detection for non-bridge-initiated sleeps (lid close, OS idle).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { readBridgeLockField } from "./transport/bridge-lock-transport.js";

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

export type ResumeKind = "dark" | "full" | "unknown";

/** Classify the current wake state. Fast, non-throwing. */
export function classifyResume(): ResumeKind {
  // Primary: our own state — most reliable, no OS log parsing.
  const status = readBridgeLockField<string>("sleepStatus");
  if (status === "hw_sleep") {
    const hour = new Date().getHours();
    const WAKE_HOUR = getEnv().wakeTime.hour;
    const BED_HOUR = getEnv().bedTime.hour;
    const inSleepWindow = (BED_HOUR < WAKE_HOUR)
      ? (hour >= BED_HOUR && hour < WAKE_HOUR)
      : (hour >= BED_HOUR || hour < WAKE_HOUR);
    return inSleepWindow ? "dark" : "full";
  }

  // Fallback: OS-specific for non-bridge-initiated sleeps (lid close, idle).
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
