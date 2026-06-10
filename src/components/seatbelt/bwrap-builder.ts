/**
 * seatbelt/bwrap-builder.ts — Build bubblewrap arguments from a SeatbeltPolicy.
 */

import type { SeatbeltPolicy } from "./policy.js";

export function buildBwrapArgs(command: string, policy: SeatbeltPolicy): string[] {
  const args: string[] = [
    "--die-with-parent",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];

  // Read-only system dirs
  for (const dir of ["/usr", "/bin", "/lib", "/lib64", "/etc", "/opt", "/sbin"]) {
    args.push("--ro-bind-try", dir, dir);
  }

  // Allowed read paths (bind read-only)
  for (const p of policy.filesystem.allowRead) {
    if (p) args.push("--ro-bind-try", p, p);
  }

  // Allowed write paths (bind read-write)
  for (const p of policy.filesystem.allowWrite) {
    if (p) args.push("--bind-try", p, p);
  }

  // Deny read paths — overlay with tmpfs (hides content)
  for (const p of policy.filesystem.denyRead) {
    if (p) args.push("--tmpfs", p);
  }

  // Network isolation
  if (policy.network.mode === "none") {
    args.push("--unshare-net");
  }
  // allowlist mode: network enabled, filtering done at app level (bwrap can't do domain-level)

  // PID namespace
  args.push("--unshare-pid");

  // Command
  args.push("--", "bash", "-c", command);

  return args;
}
