/**
 * seatbelt/seatbelt-builder.ts — Build macOS sandbox-exec profile from a SeatbeltPolicy.
 */

import type { SeatbeltPolicy } from "./policy.js";

function escapeScheme(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Basic system access
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/Library/Frameworks"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/private/var/db"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read* (subpath "/etc"))',
    '(allow file-read* (subpath "/opt"))',
    '(allow file-read-metadata)',
    // Temp
    '(allow file* (subpath "/tmp"))',
    '(allow file* (subpath "/private/tmp"))',
  ];

  // Allowed read paths
  for (const p of policy.filesystem.allowRead) {
    if (p) lines.push(`(allow file-read* (subpath "${escapeScheme(p)}"))`);
  }

  // Allowed write paths
  for (const p of policy.filesystem.allowWrite) {
    if (p) lines.push(`(allow file* (subpath "${escapeScheme(p)}"))`);
  }

  // Deny read paths (explicit deny overrides allow)
  for (const p of policy.filesystem.denyRead) {
    if (p) lines.push(`(deny file-read* (subpath "${escapeScheme(p)}"))`);
  }

  // Deny write paths
  for (const p of policy.filesystem.denyWrite) {
    if (p) lines.push(`(deny file-write* (subpath "${escapeScheme(p)}"))`);
  }

  // Network
  if (policy.network.mode === "full" || policy.network.mode === "allowlist") {
    lines.push("(allow network*)");
  }
  // mode "none" → no network rule → denied by default

  return lines.join("\n");
}
