import { existsSync, lstatSync, accessSync, mkdirSync, readFileSync, constants as fsConstants } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { abtarsHome } from "../../paths.js";
import { localDate } from "../../utils/date.js";
import { logTaskTrace } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import type { ToolExecutionScope } from "./task-package.js";

export interface ResolvedReportContract {
  artifactPath: string;
  artifactLabel: string;
  requiredSections: string[];
  minBytes: number;
  requiredFiles: Array<{ configured: string; resolved: string }>;
  executables: Array<{ name: string; resolved: string }>;
  tools: Array<{ name: string; processDependency?: { executable: string; probeArgs: string[]; timeoutMs: number } }>;
}

export interface ArtifactBaseline {
  existed: boolean;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

export type TaskPreflightResult =
  | { ok: true; report?: ResolvedReportContract; artifactBaseline?: ArtifactBaseline }
  | { ok: false; category: "definition_failed"; code: string; safeDetail: string };

const ALLOWED_ROOTS: ReadonlySet<string> = new Set([
  join(abtarsHome(), "workspace"),
  join(abtarsHome(), "tasks"),
]);

function resolvePath(raw: string, taskId: string): string {
  let p = raw.replace(/^~/, homedir());
  p = p.replace(/\{today\}/g, localDate());
  if (!p.startsWith("/")) {
    p = join(abtarsHome(), "workspace", taskId, p);
  }
  return resolve(p);
}

function isBeneathApprovedRoot(resolved: string): boolean {
  for (const root of ALLOWED_ROOTS) {
    if (resolved.startsWith(root + "/") || resolved === root) return true;
  }
  return false;
}

export function preflightTask(
  entry: ScheduledTask & { kind: "agent" },
  executionScope: ToolExecutionScope,
  toolRegistry?: { getToolDescriptor: (name: string) => { processDependency?: { executable: string; probeArgs: string[] } } | undefined },
): TaskPreflightResult {
  const taskId = entry.id;
  const contract = entry.report;
  if (entry.delivery === "report" && !contract) {
    return { ok: false, category: "definition_failed", code: "report_contract_missing", safeDetail: `report contract missing for "${taskId}"` };
  }
  if (!contract) {
    return { ok: true };
  }

  const resolvedArtifact = resolvePath(contract.artifact, taskId);
  if (!isBeneathApprovedRoot(resolvedArtifact)) {
    return { ok: false, category: "definition_failed", code: "artifact_path_invalid", safeDetail: `artifact path escapes approved workspace: ${resolvedArtifact}` };
  }

  const parentDir = dirname(resolvedArtifact);
  try {
    mkdirSync(parentDir, { recursive: true });
    accessSync(parentDir, fsConstants.W_OK);
  } catch {
    return { ok: false, category: "definition_failed", code: "artifact_parent_unwritable", safeDetail: `cannot write to artifact parent directory: ${parentDir}` };
  }

  const requiredFiles: Array<{ configured: string; resolved: string }> = [];
  for (const f of contract.requires.files) {
    const resolved = resolvePath(f, taskId);
    if (!existsSync(resolved)) {
      return { ok: false, category: "definition_failed", code: "required_file_missing", safeDetail: `required file not found: ${f}` };
    }
    try {
      accessSync(resolved, fsConstants.R_OK);
      const stat = lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, category: "definition_failed", code: "required_file_unreadable", safeDetail: `required file not a regular readable file: ${f}` };
      }
    } catch {
      return { ok: false, category: "definition_failed", code: "required_file_unreadable", safeDetail: `required file not readable: ${f}` };
    }
    requiredFiles.push({ configured: f, resolved });
  }

  const scopePath = executionScope.env["PATH"] || process.env["PATH"] || "";
  const scopePathDirs = scopePath.split(":").filter(Boolean);

  const executables: Array<{ name: string; resolved: string }> = [];
  for (const exe of contract.requires.executables) {
    let resolvedExe = "";
    if (exe.includes("/")) {
      resolvedExe = resolve(exe);
    } else {
      for (const dir of scopePathDirs) {
        const candidate = join(dir, exe);
        if (existsSync(candidate)) {
          resolvedExe = resolve(candidate);
          break;
        }
      }
    }
    if (!resolvedExe) {
      return { ok: false, category: "definition_failed", code: "required_executable_missing", safeDetail: `required executable not found in PATH: ${exe}` };
    }
    try {
      accessSync(resolvedExe, fsConstants.X_OK);
    } catch {
      return { ok: false, category: "definition_failed", code: "required_executable_not_executable", safeDetail: `required executable not executable: ${exe} (resolved: ${resolvedExe})` };
    }
    executables.push({ name: exe, resolved: resolvedExe });
  }

  const tools: Array<{ name: string; processDependency?: { executable: string; probeArgs: string[]; timeoutMs: number } }> = [];
  for (const toolName of contract.requires.tools) {
    if (!toolRegistry) {
      return { ok: false, category: "definition_failed", code: "required_tool_unregistered", safeDetail: `tool registry unavailable, cannot verify: ${toolName}` };
    }
    const descriptor = toolRegistry.getToolDescriptor(toolName);
    if (!descriptor) {
      return { ok: false, category: "definition_failed", code: "required_tool_unregistered", safeDetail: `required tool not registered: ${toolName}` };
    }
    if (descriptor.processDependency) {
      const probeExe = findExecutable(descriptor.processDependency.executable, scopePathDirs);
      if (!probeExe) {
        return { ok: false, category: "definition_failed", code: "required_tool_dependency_unavailable", safeDetail: `tool "${toolName}" process dependency "${descriptor.processDependency.executable}" not found in PATH` };
      }
      const probeResult = spawnSync(probeExe, descriptor.processDependency.probeArgs, {
        cwd: executionScope.cwd,
        env: { ...executionScope.env, PATH: scopePath },
        timeout: 5000,
        stdio: "ignore",
        shell: false,
      });
      if (probeResult.error || probeResult.status !== 0 || probeResult.signal) {
        return { ok: false, category: "definition_failed", code: "required_tool_dependency_unavailable", safeDetail: `tool "${toolName}" process dependency probe failed: exit=${probeResult.status} signal=${probeResult.signal}` };
      }
      tools.push({ name: toolName, processDependency: { ...descriptor.processDependency, timeoutMs: 5000 } });
    } else {
      tools.push({ name: toolName });
    }
  }

  let artifactBaseline: ArtifactBaseline | undefined;
  if (existsSync(resolvedArtifact)) {
    try {
      const stat = lstatSync(resolvedArtifact);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        artifactBaseline = { existed: true, size: stat.size, mtimeMs: stat.mtimeMs };
      }
    } catch {
      artifactBaseline = { existed: false };
    }
  } else {
    artifactBaseline = { existed: false };
  }

  logTaskTrace("task_preflight_passed", { task: taskId }, `artifact=${resolvedArtifact} files=${requiredFiles.length} executables=${executables.length} tools=${tools.length}`);

  return {
    ok: true,
    report: {
      artifactPath: resolvedArtifact,
      artifactLabel: contract.artifact,
      requiredSections: contract.requiredSections,
      minBytes: contract.minBytes,
      requiredFiles,
      executables,
      tools,
    },
    artifactBaseline,
  };
}

function findExecutable(name: string, pathDirs: string[]): string | undefined {
  if (name.includes("/")) {
    return existsSync(name) && accessSync(name, fsConstants.X_OK) === undefined ? name : undefined;
  }
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function validateReportArtifact(
  resolvedPath: string,
  baseline: ArtifactBaseline | undefined,
  contract: ResolvedReportContract,
  reservedAt: number,
  _taskId: string,
): { ok: true; size: number } | { ok: false; reason: string } {
  if (!existsSync(resolvedPath)) {
    return { ok: false, reason: `artifact not found: ${resolvedPath}` };
  }
  let stat;
  try {
    stat = lstatSync(resolvedPath);
  } catch {
    return { ok: false, reason: `cannot stat artifact: ${resolvedPath}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, reason: `artifact is not a regular file` };
  }
  try {
    accessSync(resolvedPath, fsConstants.R_OK);
  } catch {
    return { ok: false, reason: `artifact not readable` };
  }

  if (stat.size < contract.minBytes) {
    return { ok: false, reason: `artifact too small: ${stat.size} bytes (minimum ${contract.minBytes})` };
  }

  const content = readFileSyncSafe(resolvedPath);
  if (content === undefined) {
    return { ok: false, reason: `cannot read artifact content` };
  }
  for (const heading of contract.requiredSections) {
    if (!content.includes(heading)) {
      return { ok: false, reason: `required heading not found: "${heading}"` };
    }
  }

  if (baseline) {
    if (baseline.existed) {
      if (stat.size === baseline.size && stat.mtimeMs === baseline.mtimeMs) {
        return { ok: false, reason: `artifact unchanged from baseline (same size and mtime)` };
      }
    }
  }

  const fsTolerance = 2000;
  if (stat.mtimeMs < reservedAt - fsTolerance) {
    return { ok: false, reason: `artifact mtime (${new Date(stat.mtimeMs).toISOString()}) is before reservation (${new Date(reservedAt).toISOString()})` };
  }

  return { ok: true, size: stat.size };
}

function readFileSyncSafe(p: string): string | undefined {
  try { return readFileSync(p, "utf-8"); } catch { return undefined; }
}
