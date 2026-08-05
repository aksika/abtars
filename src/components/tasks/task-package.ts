import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { logTrace } from "../logger.js";
import { abtarsHome } from "../../paths.js";
import { localDate } from "../../utils/date.js";

const TAG = "task-package";

export interface TaskPackageResult {
  ok: true;
  prompt: string;
  contextFiles: Array<{ name: string; chars: number }>;
}

export interface TaskPackageError {
  ok: false;
  error: string;
}

export function loadTaskPackage(taskFile: string): TaskPackageResult | TaskPackageError {
  const filePath = resolve(taskFile.replace(/^~/, homedir()));
  if (!existsSync(filePath)) {
    return { ok: false, error: `Task file not found: ${filePath}` };
  }
  const raw = readFileSync(filePath, "utf-8");
  const today = localDate();
  const content = raw.replace(/\{today\}/g, today);

  let prompt = content.trim();

  const dir = dirname(filePath);
  const base = basename(filePath, ".md");
  const BACKUP_EXTS = new Set([".bak", ".backup", ".tmp", ".swp"]);
  const contextFiles: Array<{ name: string; chars: number }> = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `Cannot read task directory: ${err instanceof Error ? err.message : String(err)}` };
  }
  // #1502 Task 10: regular files only. Exclude the task definition itself,
  // dotfiles, backup/temp files, tilda-suffix files, and — critically —
  // directories and symlinks (readdirSync returns both; readFileSync on a
  // directory throws EISDIR). Previously a subdirectory sibling crashed the
  // whole task path with an unhandled exception.
  const associated = entries
    .filter(d => {
      if (!d.isFile()) return false;
      if (d.name === base + ".md") return false;
      if (d.name.startsWith(".")) return false;
      const ext = d.name.includes(".") ? d.name.slice(d.name.lastIndexOf(".")).toLowerCase() : "";
      if (BACKUP_EXTS.has(ext)) return false;
      if (d.name.endsWith("~")) return false;
      return true;
    })
    .map(d => d.name)
    .sort();
  if (associated.length > 0) {
    let injected = "\n\n---\n## Associated files\n";
    let totalChars = 0;
    const CAP = 10_000;
    for (const f of associated) {
      let fc: string;
      try {
        fc = readFileSync(join(dir, f), "utf-8");
      } catch (err) {
        // #1502: surface unreadable context as a visible definition failure
        // rather than crashing the task path or silently omitting the file.
        return { ok: false, error: `Cannot read associated context file "${f}": ${err instanceof Error ? err.message : String(err)}` };
      }
      const chars = fc.length;
      if (totalChars + chars > CAP) {
        injected += `\n[${f}]: (truncated — full file at ${join(dir, f)})\n`;
        contextFiles.push({ name: f, chars });
        break;
      }
      injected += `\n### ${f}\n\`\`\`\n${fc}\n\`\`\`\n`;
      totalChars += chars;
      contextFiles.push({ name: f, chars });
    }
    prompt += injected;
  }

  logTrace(TAG, `task_package_loaded definition=${basename(filePath)} context_count=${contextFiles.length} context_chars=${contextFiles.reduce((sum, file) => sum + file.chars, 0)}`);

  return { ok: true, prompt, contextFiles };
}

export type DeliveryMode = "silent" | "deliver" | "announce" | "report";

export interface ToolExecutionScope {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export function createExecutionScope(taskId: string): ToolExecutionScope {
  const workspace = join(abtarsHome(), "workspace", taskId);
  // The scope cwd doubles as the execute_bash working directory; a missing
  // directory makes every bash spawn fail with ENOENT (#1544).
  mkdirSync(workspace, { recursive: true });
  return {
    cwd: workspace,
    env: Object.freeze({ WORKSPACE: workspace }),
  };
}
