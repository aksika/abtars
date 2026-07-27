import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { logWarn } from "../logger.js";
import { abtarsHome } from "../../paths.js";
import { localDate } from "../../utils/date.js";

const TAG = "task-package";

export interface TaskPackageResult {
  ok: true;
  prompt: string;
  dodPaths: string[];
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

  const dodIdx = content.indexOf("## Definition of Done");
  let prompt: string;
  let dodPaths: string[] = [];
  if (dodIdx === -1) {
    prompt = content.trim();
  } else {
    prompt = content.slice(0, dodIdx).trim();
    const dodSection = content.slice(dodIdx);
    dodPaths = dodSection.split("\n")
      .filter(l => l.match(/^- /))
      .map(l => l.replace(/^- /, "").trim())
      .filter(p => {
        if (p.length === 0 || p.includes(" ") || p.includes("\t") || (!p.startsWith("/") && !p.startsWith("~"))) {
          logWarn(TAG, `Rejected malformed DoD path: "${p}" — must be absolute or ~/ path`);
          return false;
        }
        return true;
      })
      .map(p => resolve(p.replace(/^~/, homedir())));
  }

  const dir = dirname(filePath);
  const base = basename(filePath, ".md");
  const BACKUP_EXTS = new Set([".bak", ".backup", ".tmp", ".swp"]);
  const contextFiles: Array<{ name: string; chars: number }> = [];
  const associated = readdirSync(dir)
    .filter(f => {
      if (f === base + ".md") return false;
      if (f.startsWith(".")) return false;
      const ext = f.includes(".") ? f.slice(f.lastIndexOf(".")).toLowerCase() : "";
      if (BACKUP_EXTS.has(ext)) return false;
      if (f.endsWith("~")) return false;
      return true;
    })
    .sort();
  if (associated.length > 0) {
    let injected = "\n\n---\n## Associated files\n";
    let totalChars = 0;
    const CAP = 10_000;
    for (const f of associated) {
      const fc = readFileSync(join(dir, f), "utf-8");
      const chars = fc.length;
      if (totalChars + chars > CAP) {
        injected += `\n[${f}]: (truncated — full file at ${join(dir, f)})\n`;
        break;
      }
      injected += `\n### ${f}\n\`\`\`\n${fc}\n\`\`\`\n`;
      totalChars += chars;
      contextFiles.push({ name: f, chars });
    }
    prompt += injected;
  }

  return { ok: true, prompt, dodPaths, contextFiles };
}

export type DeliveryMode = "silent" | "deliver" | "announce" | "report";

export interface ToolExecutionScope {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export function createExecutionScope(taskId: string): ToolExecutionScope {
  const workspace = join(abtarsHome(), "workspace", taskId);
  return {
    cwd: workspace,
    env: Object.freeze({ WORKSPACE: workspace }),
  };
}
