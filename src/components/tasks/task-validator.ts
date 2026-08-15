import { existsSync, readFileSync, readdirSync, lstatSync, accessSync, statSync, constants as fsConstants } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { normalize, isAgentTask } from "./task-types.js";
import { resolveTaskFilePath, resolveTaskContractPath } from "./task-paths.js";
import type { Dirent } from "node:fs";
import type { ScheduledTask } from "./task-types.js";

export type TaskValidationFindingCode =
  | "file_missing"
  | "file_unreadable"
  | "json_invalid"
  | "root_not_array"
  | "entry_invalid"
  | "duplicate_id"
  | "task_file_missing"
  | "task_file_unreadable"
  | "required_file_missing"
  | "required_file_unreadable"
  | "task_packages_unreadable"
  | "orphan_task_package";

export interface TaskValidationFinding {
  code: TaskValidationFindingCode;
  message: string;
  entryIndex?: number;
  entryId?: string;
  configuredPath?: string;
  path?: string;
}

export interface TaskValidationResult {
  ok: boolean;
  path: string;
  summary: {
    entryCount: number;
    validEntryCount: number;
    findingCount: number;
  };
  findings: TaskValidationFinding[];
}

interface ValidEntryRef {
  entryIndex: number;
  entry: ScheduledTask;
}

/**
 * #1594: read-only whole-document dry run for a tasks.json file. Reuses the
 * production `normalize()` parser as the source of truth, cross-checks the
 * resolved taskFile/report paths against the filesystem with the same rules
 * as runtime loading, and reports orphaned task package directories. Never
 * writes files and never initializes runtime state.
 */
export function validateTaskFile(path?: string): TaskValidationResult {
  const resolvedPath = path ? resolve(path.replace(/^~/, homedir())) : join(abtarsHome(), "tasks", "tasks.json");
  const findings: TaskValidationFinding[] = [];

  if (!existsSync(resolvedPath)) {
    findings.push({ code: "file_missing", message: `task file not found: ${resolvedPath}`, path: resolvedPath });
    return result(resolvedPath, findings, 0, 0);
  }
  let rawText: string;
  try {
    rawText = readFileSync(resolvedPath, "utf-8");
  } catch {
    findings.push({ code: "file_unreadable", message: `task file not readable: ${resolvedPath}`, path: resolvedPath });
    return result(resolvedPath, findings, 0, 0);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    findings.push({ code: "json_invalid", message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`, path: resolvedPath });
    return result(resolvedPath, findings, 0, 0);
  }
  if (!Array.isArray(raw)) {
    findings.push({ code: "root_not_array", message: "task document root must be an array", path: resolvedPath });
    return result(resolvedPath, findings, 0, 0);
  }

  const valid: ValidEntryRef[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const parsed = normalize(raw[i]);
    if (!parsed.ok) {
      findings.push({
        code: "entry_invalid",
        message: parsed.error,
        entryIndex: i,
        ...(parsed.id ? { entryId: parsed.id } : {}),
      });
      continue;
    }
    if (seenIds.has(parsed.entry.id)) {
      findings.push({
        code: "duplicate_id",
        message: `duplicate task id: ${parsed.entry.id}`,
        entryIndex: i,
        entryId: parsed.entry.id,
      });
    }
    seenIds.add(parsed.entry.id);
    valid.push({ entryIndex: i, entry: parsed.entry });
  }

  const taskRoot = join(abtarsHome(), "tasks");
  const referencedPackages = new Set<string>();
  for (const { entryIndex, entry } of valid) {
    if (!isAgentTask(entry)) continue;
    if (entry.taskFile) {
      const resolved = resolveTaskFilePath(entry.taskFile);
      if (!existsSync(resolved)) {
        findings.push({
          code: "task_file_missing",
          message: `task file not found: ${entry.taskFile}`,
          entryIndex,
          entryId: entry.id,
          configuredPath: entry.taskFile,
          path: resolved,
        });
      } else {
        try {
          const stat = statSync(resolved);
          if (!stat.isFile()) {
            findings.push({
              code: "task_file_unreadable",
              message: `task file is not a regular file: ${entry.taskFile}`,
              entryIndex,
              entryId: entry.id,
              configuredPath: entry.taskFile,
              path: resolved,
            });
          } else {
            readFileSync(resolved, "utf-8");
          }
        } catch {
          findings.push({
            code: "task_file_unreadable",
            message: `task file not readable: ${entry.taskFile}`,
            entryIndex,
            entryId: entry.id,
            configuredPath: entry.taskFile,
            path: resolved,
          });
        }
      }
      const pkg = referencedPackage(taskRoot, resolved);
      if (pkg) referencedPackages.add(pkg);
    }
    if (entry.report) {
      for (const f of entry.report.requires.files) {
        const resolved = resolveTaskContractPath(f, entry.id);
        if (!existsSync(resolved)) {
          findings.push({
            code: "required_file_missing",
            message: `required file not found: ${f}`,
            entryIndex,
            entryId: entry.id,
            configuredPath: f,
            path: resolved,
          });
          continue;
        }
        try {
          accessSync(resolved, fsConstants.R_OK);
          const stat = lstatSync(resolved);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            findings.push({
              code: "required_file_unreadable",
              message: `required file not a regular readable file: ${f}`,
              entryIndex,
              entryId: entry.id,
              configuredPath: f,
              path: resolved,
            });
          }
        } catch {
          findings.push({
            code: "required_file_unreadable",
            message: `required file not readable: ${f}`,
            entryIndex,
            entryId: entry.id,
            configuredPath: f,
            path: resolved,
          });
        }
      }
    }
  }

  scanOrphanPackages(taskRoot, referencedPackages, findings);

  return result(resolvedPath, findings, raw.length, valid.length);
}

function result(
  path: string,
  findings: TaskValidationFinding[],
  entryCount: number,
  validEntryCount: number,
): TaskValidationResult {
  return {
    ok: findings.length === 0,
    path,
    summary: { entryCount, validEntryCount, findingCount: findings.length },
    findings,
  };
}

/** First path segment of the resolved taskFile below the task root, when the
 *  task file lives inside a child directory. A task file directly in the root,
 *  or outside the root, references no child package. Lexical comparison only —
 *  no realpath canonicalization. */
function referencedPackage(taskRoot: string, resolvedTaskFile: string): string | undefined {
  const rel = relative(taskRoot, resolvedTaskFile);
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) return undefined;
  const first = rel.split("/")[0]!;
  if (first === rel) return undefined;
  return first;
}

function scanOrphanPackages(taskRoot: string, referenced: Set<string>, findings: TaskValidationFinding[]): void {
  if (!existsSync(taskRoot)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(taskRoot, { withFileTypes: true });
  } catch {
    findings.push({
      code: "task_packages_unreadable",
      message: `cannot read task package root: ${taskRoot}`,
      path: taskRoot,
    });
    return;
  }
  for (const name of entries.filter(d => d.isDirectory()).map(d => d.name).sort()) {
    if (!referenced.has(name)) {
      findings.push({
        code: "orphan_task_package",
        message: `task package not referenced by any entry: ${name}`,
        path: join(taskRoot, name),
      });
    }
  }
}
