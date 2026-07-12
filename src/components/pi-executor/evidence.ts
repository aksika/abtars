import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_CHANGED_FILES_CHARS } from "./types.js";

export function captureGitEvidence(workspacePath: string): { head: string; status: string } | null {
  try {
    const gitDir = resolve(workspacePath, ".git");
    if (!existsSync(gitDir)) return null;
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: workspacePath, encoding: "utf-8", timeout: 5000 }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: workspacePath, encoding: "utf-8", timeout: 5000 }).trim();
    return { head, status };
  } catch {
    return null;
  }
}

export function computeChangedFilesSummary(before: { head?: string; status?: string } | null, after: { head?: string; status?: string } | null): string {
  if (!before && !after) return "Changed-file evidence unavailable";
  if (!before) return "Workspace was not present before run";
  if (!after) return "Workspace could not be read after run";

  const parts: string[] = [];
  if (before.head !== after.head) {
    parts.push(`HEAD changed: ${before.head} → ${after.head}`);
  }
  if (before.status !== after.status) {
    const beforeLines = before.status ? before.status.split("\n").filter(Boolean) : [];
    const afterLines = after.status ? after.status.split("\n").filter(Boolean) : [];
    const added = afterLines.filter(l => !beforeLines.includes(l));
    const removed = beforeLines.filter(l => !afterLines.includes(l));
    if (added.length > 0) parts.push(`Files changed: ${added.length} new/modified`);
    if (removed.length > 0) parts.push(`Files removed: ${removed.length}`);
    parts.push(`\n${(after.status ?? "").slice(0, MAX_CHANGED_FILES_CHARS)}`);
  } else {
    parts.push("No file changes detected");
  }
  return parts.join("\n").slice(0, MAX_CHANGED_FILES_CHARS);
}
