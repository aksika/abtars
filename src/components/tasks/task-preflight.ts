import { existsSync, lstatSync, accessSync, mkdirSync, readFileSync, openSync, readSync, fstatSync, closeSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { abtarsHome } from "../../paths.js";
import { localDate } from "../../utils/date.js";
import { logTaskTrace } from "./task-log-ctx.js";
import { resolveTaskContractPath } from "./task-paths.js";
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

export interface TaskToolRegistry {
  getToolDescriptor(name: string): { processDependency?: { executable: string; probeArgs: string[] } } | undefined;
}

export type TaskPreflightResult =
  | { ok: true; report?: ResolvedReportContract; artifactBaseline?: ArtifactBaseline }
  | { ok: false; category: "definition_failed"; code: string; safeDetail: string };

const ALLOWED_ROOTS: ReadonlySet<string> = new Set([
  join(abtarsHome(), "workspace"),
  join(abtarsHome(), "tasks"),
]);

/** Substitute the {today} placeholder with the local date. Applied to every
 *  part of a report contract that names a dated thing — artifact path and
 *  required headings alike — so both agree on one date for the whole run. */
function substituteToday(raw: string): string {
  return raw.replace(/\{today\}/g, localDate());
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
  toolRegistry?: TaskToolRegistry,
): TaskPreflightResult {
  const taskId = entry.id;
  const contract = entry.report;
  if (entry.delivery === "report" && !contract) {
    return { ok: false, category: "definition_failed", code: "report_contract_missing", safeDetail: `report contract missing for "${taskId}"` };
  }
  if (!contract) {
    return { ok: true };
  }

  const resolvedArtifact = resolveTaskContractPath(contract.artifact, taskId);
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
    const resolved = resolveTaskContractPath(f, taskId);
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
      requiredSections: contract.requiredSections.map(substituteToday),
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
): { ok: true; size: number } | { ok: false; code: string; reason: string } {
  if (!existsSync(resolvedPath)) {
    return { ok: false, code: "artifact_not_found", reason: `artifact not found: ${resolvedPath}` };
  }
  let stat;
  try {
    stat = lstatSync(resolvedPath);
  } catch {
    return { ok: false, code: "artifact_not_found", reason: `cannot stat artifact: ${resolvedPath}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, code: "artifact_not_regular_file", reason: `artifact is not a regular file` };
  }
  try {
    accessSync(resolvedPath, fsConstants.R_OK);
  } catch {
    return { ok: false, code: "artifact_unreadable", reason: `artifact not readable` };
  }

  if (stat.size < contract.minBytes) {
    return { ok: false, code: "artifact_too_small", reason: `artifact too small: ${stat.size} bytes (minimum ${contract.minBytes})` };
  }

  const content = readFileSyncSafe(resolvedPath);
  if (content === undefined) {
    return { ok: false, code: "artifact_unreadable", reason: `cannot read artifact content` };
  }
  return evaluateReportObservation(
    { sizeBytes: stat.size, mtimeMs: stat.mtimeMs },
    content,
    baseline,
    { minBytes: contract.minBytes, requiredSections: contract.requiredSections },
    reservedAt,
  );
}

/**
 * #1791: the shared mechanical evaluator — metadata plus content checks with
 * the exact codes, reasons, and precedence of `validateReportArtifact`
 * (min-size → headings → baseline-unchanged → stale). Both the admission
 * path (which stats + reads the file itself) and the review-capture path
 * (which reads through a held descriptor) evaluate through here, so the two
 * layers cannot disagree on what "valid" means.
 */
function evaluateReportObservation(
  meta: { sizeBytes: number; mtimeMs: number },
  content: string,
  baseline: ArtifactBaseline | undefined,
  contract: { minBytes: number; requiredSections: string[] },
  reservedAt: number,
): { ok: true; size: number } | { ok: false; code: string; reason: string } {
  if (meta.sizeBytes < contract.minBytes) {
    return { ok: false, code: "artifact_too_small", reason: `artifact too small: ${meta.sizeBytes} bytes (minimum ${contract.minBytes})` };
  }
  for (const heading of contract.requiredSections) {
    if (!content.includes(heading)) {
      return { ok: false, code: "required_heading_missing", reason: `required heading not found: "${heading}"` };
    }
  }

  if (baseline) {
    if (baseline.existed) {
      if (meta.sizeBytes === baseline.size && meta.mtimeMs === baseline.mtimeMs) {
        return { ok: false, code: "artifact_unchanged_baseline", reason: `artifact unchanged from baseline (same size and mtime)` };
      }
    }
  }

  const fsTolerance = 2000;
  if (meta.mtimeMs < reservedAt - fsTolerance) {
    return { ok: false, code: "artifact_stale_mtime", reason: `artifact mtime (${new Date(meta.mtimeMs).toISOString()}) is before reservation (${new Date(reservedAt).toISOString()})` };
  }

  return { ok: true, size: meta.sizeBytes };
}

/**
 * #1791: review-only capture bound. Larger than any legitimate briefing, far
 * below the 1MB tool-result ceiling. Applies to review capture only — the
 * admission validator keeps its unbounded behavior.
 */
export const REPORT_CAPTURE_MAX_BYTES = 65_536;

export type ReportCaptureUnavailableCode =
  | "report_read_failed"
  | "report_changed_during_capture"
  | "report_too_large"
  | "report_encoding_invalid";

export type ReportCaptureResult =
  | { ok: true; content: string; digest: string; sizeBytes: number; mtimeMs: number }
  | { ok: false; kind: "invalid"; code: string; reason: string }
  | { ok: false; kind: "unavailable"; code: ReportCaptureUnavailableCode; reason: string };

/**
 * #1791: bounded, consistent capture of a declared report artifact for review
 * evidence. Opens with no-follow/nonblocking flags so a raced FIFO cannot
 * block the bridge, verifies a regular file on the descriptor, reads at most
 * limit + 1 bytes, and re-inspects descriptor/path metadata afterward —
 * detected replacement or modification refuses with an unavailable
 * observation, never positive evidence from inconsistent reads. Content,
 * digest, size, and validation always describe the same captured bytes: the
 * mechanical evaluator runs over the captured buffer, never a reread.
 */
export function captureReportArtifact(
  artifactPath: string,
  contract: { minBytes: number; requiredSections: string[]; baseline?: ArtifactBaseline },
  reservedAt: number,
): ReportCaptureResult {
  let preStat;
  try {
    preStat = lstatSync(artifactPath);
  } catch {
    return { ok: false, kind: "invalid", code: "artifact_not_found", reason: `artifact not found: ${artifactPath}` };
  }
  if (!preStat.isFile() || preStat.isSymbolicLink()) {
    return { ok: false, kind: "invalid", code: "artifact_not_regular_file", reason: `artifact is not a regular file` };
  }

  let fd: number | undefined;
  const closeQuiet = (): void => {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed — nothing to report */ }
      fd = undefined;
    }
  };
  try {
    try {
      fd = openSync(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ELOOP") {
        return { ok: false, kind: "invalid", code: "artifact_not_regular_file", reason: `artifact is not a regular file` };
      }
      if (code === "ENOENT") {
        return { ok: false, kind: "invalid", code: "artifact_not_found", reason: `artifact not found: ${artifactPath}` };
      }
      return { ok: false, kind: "unavailable", code: "report_read_failed", reason: `cannot open artifact: ${code ?? "unknown"}` };
    }
    const snap = fstatSync(fd);
    if (!snap.isFile()) {
      return { ok: false, kind: "invalid", code: "artifact_not_regular_file", reason: `artifact is not a regular file` };
    }
    if (snap.dev !== preStat.dev || snap.ino !== preStat.ino) {
      return { ok: false, kind: "unavailable", code: "report_changed_during_capture", reason: `artifact replaced between stat and open` };
    }
    if (snap.size > REPORT_CAPTURE_MAX_BYTES) {
      return { ok: false, kind: "unavailable", code: "report_too_large", reason: `artifact size ${snap.size} exceeds capture bound ${REPORT_CAPTURE_MAX_BYTES}` };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(8192);
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return { ok: false, kind: "unavailable", code: "report_read_failed", reason: `cannot read artifact: ${code ?? "unknown"}` };
      }
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
      if (total > REPORT_CAPTURE_MAX_BYTES) {
        return { ok: false, kind: "unavailable", code: "report_too_large", reason: `artifact exceeds capture bound ${REPORT_CAPTURE_MAX_BYTES}` };
      }
    }
    const data = Buffer.concat(chunks, total);

    let postFd;
    try {
      postFd = fstatSync(fd);
    } catch {
      return { ok: false, kind: "unavailable", code: "report_read_failed", reason: `cannot restat artifact` };
    }
    let postPath;
    try {
      postPath = lstatSync(artifactPath);
    } catch {
      return { ok: false, kind: "unavailable", code: "report_changed_during_capture", reason: `artifact removed during capture` };
    }
    const consistent =
      postFd.dev === snap.dev && postFd.ino === snap.ino &&
      postFd.size === snap.size && postFd.mtimeMs === snap.mtimeMs && postFd.ctimeMs === snap.ctimeMs &&
      postPath.dev === snap.dev && postPath.ino === snap.ino &&
      postPath.size === snap.size && postPath.mtimeMs === snap.mtimeMs && postPath.ctimeMs === snap.ctimeMs;
    if (!consistent) {
      return { ok: false, kind: "unavailable", code: "report_changed_during_capture", reason: `artifact modified during capture` };
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return { ok: false, kind: "unavailable", code: "report_encoding_invalid", reason: `artifact is not valid UTF-8` };
    }

    const evaluated = evaluateReportObservation(
      { sizeBytes: data.length, mtimeMs: postFd.mtimeMs },
      content,
      contract.baseline,
      { minBytes: contract.minBytes, requiredSections: contract.requiredSections },
      reservedAt,
    );
    if (!evaluated.ok) {
      return { ok: false, kind: "invalid", code: evaluated.code, reason: evaluated.reason };
    }
    return {
      ok: true,
      content,
      digest: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
      mtimeMs: postFd.mtimeMs,
    };
  } finally {
    closeQuiet();
  }
}

function readFileSyncSafe(p: string): string | undefined {
  try { return readFileSync(p, "utf-8"); } catch { return undefined; }
}
