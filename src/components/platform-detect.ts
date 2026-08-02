import { logAndSwallow } from "./log-and-swallow.js";
/**
 * Platform-specific wake classification.
 * Detects whether a resume from sleep is a background wake (darkwake) or full user wake.
 *
 * #1532: the bridge-owned hardware suspend marker (state/power-transition.json,
 * written by the #1322 hardware-sleep power action) is classified first — it is
 * authoritative over the OS log inside the owned overnight window. General
 * standby detection for non-bridge-initiated sleeps (lid close, OS idle)
 * remains the OS fallback used by the heartbeat resume handler.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { PowerTransitionStore } from "../capabilities/power/power-transition-store.js";
import type { PowerTransitionState } from "../capabilities/power/types.js";

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

/** #1532: injectable inputs for the resume classifier (tests only). */
export interface ClassifyResumeOptions {
  /** Power-transition marker store; defaults to the runtime file. */
  transitionStore?: PowerTransitionStore;
  /** Clock for the owned-window boundary checks; defaults to Date.now(). */
  now?: number;
}

/** Classify the current wake state. Fast, non-throwing. */
export function classifyResume(opts: ClassifyResumeOptions = {}): ResumeKind {
  const owned = classifyBridgeOwnedSuspend(opts);
  if (owned !== null) return owned;
  // OS-specific detection for non-bridge-initiated sleeps (lid close, idle).
  const os = platform();
  if (os === "darwin") return classifyMacOS();
  if (os === "linux") return classifyLinux();
  return "unknown";
}

/**
 * #1532: classify the bridge-owned hardware suspend window from the
 * power-transition marker. A valid, unexpired marker means the bridge itself
 * requested the hardware suspend; pre-wake darkwakes are `"dark"`, and the
 * expected-wake boundary is the deterministic handoff back to `"full"`.
 * Absent, corrupt, malformed, future-requested, or expired markers return
 * null so the caller falls through to OS detection.
 */
function classifyBridgeOwnedSuspend(opts: ClassifyResumeOptions): ResumeKind | null {
  const store = opts.transitionStore ?? new PowerTransitionStore();
  const state = store.read();
  if (!state) return null;
  const now = opts.now ?? Date.now();
  if (!isOwnedTransition(state, now)) return null;
  return now < state.expectedWakeAt ? "dark" : "full";
}

function isOwnedTransition(state: PowerTransitionState, now: number): boolean {
  if (state.state !== "suspending") return false;
  if (state.taskId !== "hardware-sleep") return false;
  const { requestedAt, expectedWakeAt, expiresAt } = state;
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expectedWakeAt) || !Number.isFinite(expiresAt)) {
    return false;
  }
  if (!(requestedAt <= expectedWakeAt && expectedWakeAt <= expiresAt)) return false;
  // Reject future requestedAt: the suspend was not issued yet.
  return requestedAt <= now;
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
