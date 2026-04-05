/**
 * Platform-specific wake classification.
 * Detects whether a resume from sleep is a background wake (darkwake) or full user wake.
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

export type ResumeKind = "dark" | "full" | "unknown";

/** Classify the current wake state. Fast, non-throwing. */
export function classifyResume(): ResumeKind {
  const os = platform();
  if (os === "darwin") return classifyMacOS();
  if (os === "linux") return classifyLinux();
  return "unknown";
}

function classifyMacOS(): ResumeKind {
  try {
    const out = execSync("pmset -g systemstate 2>/dev/null", { timeout: 3000, encoding: "utf-8" });
    if (out.includes("DarkWake")) return "dark";
    if (out.includes("FullWake")) return "full";
  } catch { /* */ }
  return "unknown";
}

function classifyLinux(): ResumeKind {
  try {
    // Check if systemd logged a suspend resume within the last 5 minutes
    const out = execSync(
      "journalctl -b -u systemd-suspend.service --since '5 min ago' --no-pager -q 2>/dev/null",
      { timeout: 3000, encoding: "utf-8" },
    );
    if (out.trim().length > 0) return "full"; // Linux has no darkwake — any suspend resume is full
  } catch { /* journalctl not available or no systemd */ }
  return "unknown";
}
