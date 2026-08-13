/**
 * worker-evidence-verifier.ts — #1656: the single neutral Worker evidence
 * evaluator.
 *
 * One boundary owns verification-command execution, artifact observation, and
 * criterion derivation for BOTH executors (Spin and supervised Pi). It is
 * executor-neutral and provider-free: it receives only the exact contract and
 * the canonical verification root.
 *
 * Workspace containment is component-aware and symlink-safe via the shared
 * `isPathWithinRoot` utility. A missing in-workspace target reports
 * `not found`; an existing target or parent symlink escaping the canonical
 * workspace reports `path escapes workspace`. A missing/unreadable workspace
 * fails the affected checks/artifacts/criteria with bounded evidence and
 * NEVER causes process-cwd verification.
 */
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { isPathWithinRoot } from "./pi-executor/config.js";
import { MAX_CHECK_OUTPUT_LENGTH } from "./worker-contract.js";
import type { WorkerAcceptanceContractV1, VerificationObservation, ArtifactObservation, CriterionStatus } from "./worker-contract.js";

const MAX_CHECK_STDIO_EXCERPT = MAX_CHECK_OUTPUT_LENGTH;

export interface WorkerEvidenceEvaluation {
  checks: VerificationObservation[];
  artifacts: ArtifactObservation[];
  criteria: Array<{
    criterion_id: string;
    status: CriterionStatus;
    evidence_ids: string[];
  }>;
}

export type WorkspaceMemberResolution =
  | { kind: "ok"; absolute: string }
  | { kind: "missing"; reason: "not found" }
  | { kind: "escape"; reason: "path escapes workspace" }
  | { kind: "invalid_workspace"; reason: string };

/**
 * #1656: resolve one admitted workspace-relative path against the canonical
 * workspace root.
 *
 * 1. The workspace itself must canonicalize to an existing directory.
 * 2. The lexical resolution must stay inside the root (component-aware).
 * 3. An existing target is accepted only when its real path is inside the
 *    root — a symlink escaping the workspace is an escape.
 * 4. A missing target is accepted only when its nearest existing parent
 *    canonicalizes inside the root; it reports `not found`, not an escape.
 */
export function resolveWorkspaceMember(
  workspaceCwd: string | undefined,
  relativePath: string,
): WorkspaceMemberResolution {
  if (!workspaceCwd || workspaceCwd.length === 0) {
    return { kind: "invalid_workspace", reason: "workspace unavailable" };
  }
  let root: string;
  try {
    const st = statSync(workspaceCwd);
    if (!st.isDirectory()) return { kind: "invalid_workspace", reason: "workspace is not a directory" };
    root = realpathSync(workspaceCwd);
  } catch (err) {
    return { kind: "invalid_workspace", reason: `workspace unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const absolute = resolve(root, relativePath);
  if (!isPathWithinRoot(root, absolute)) {
    return { kind: "escape", reason: "path escapes workspace" };
  }

  if (existsSync(absolute)) {
    try {
      const real = realpathSync(absolute);
      if (!isPathWithinRoot(root, real)) {
        return { kind: "escape", reason: "path escapes workspace" };
      }
    } catch {
      // Target vanished between exists and realpath — treat as not found.
      return { kind: "missing", reason: "not found" };
    }
    return { kind: "ok", absolute };
  }

  // Missing target: canonicalize the nearest existing parent. A parent
  // symlink outside the root is an escape; otherwise the target is simply
  // not found.
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const parentReal = realpathSync(probe);
    if (!isPathWithinRoot(root, parentReal)) {
      return { kind: "escape", reason: "path escapes workspace" };
    }
  } catch {
    return { kind: "invalid_workspace", reason: "workspace parent unreadable" };
  }
  return { kind: "missing", reason: "not found" };
}

/**
 * Evaluate one contract against the verification root. When the workspace is
 * missing/unreadable every check and artifact fails with bounded evidence and
 * every criterion is derived from those failed observations — no command is
 * spawned and `process.cwd()` is never used.
 */
export function evaluateWorkerEvidence(
  contract: WorkerAcceptanceContractV1,
  workspaceCwd: string | undefined,
): WorkerEvidenceEvaluation {
  let root: string | undefined;
  if (workspaceCwd && workspaceCwd.length > 0) {
    const resolved = resolveWorkspaceMember(workspaceCwd, ".");
    if (resolved.kind === "ok") root = resolved.absolute;
  }

  const checks = runChecks(contract, root);
  const artifacts = observeArtifacts(contract, root);
  const criteria = deriveCriteria(contract, checks, artifacts);
  return { checks, artifacts, criteria };
}

function workspaceFailureStderr(workspaceCwd: string | undefined, reason?: string): string {
  if (!workspaceCwd || workspaceCwd.length === 0) return "workspace unavailable: verification skipped";
  return `workspace unavailable (${reason ?? "unreadable"}): verification skipped`;
}

function runChecks(contract: WorkerAcceptanceContractV1, workspaceRoot: string | undefined): VerificationObservation[] {
  return contract.verification_commands.map(cmd => {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    let exitCode: number | null = null;
    let signal: string | null = null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let cwd: string;
    if (workspaceRoot === undefined) {
      stderr = workspaceFailureStderr(workspaceRoot);
      return {
        check_id: cmd.id, argv: cmd.argv, cwd: cmd.cwd,
        started_at: startedAt, finished_at: finishedAt,
        timed_out: false, exit_code: null, signal: null,
        stdout_excerpt: "", stderr_excerpt: stderr.slice(0, MAX_CHECK_STDIO_EXCERPT),
      };
    }
    if (cmd.cwd) {
      const resolved = resolveWorkspaceMember(workspaceRoot, cmd.cwd);
      if (resolved.kind !== "ok") {
        stderr = resolved.kind === "escape"
          ? `rejected: cwd escapes workspace (${cmd.cwd})`
          : resolved.kind === "missing"
            ? `rejected: verification cwd not found (${cmd.cwd})`
            : workspaceFailureStderr(workspaceRoot, resolved.reason);
        return {
          check_id: cmd.id, argv: cmd.argv, cwd: cmd.cwd,
          started_at: startedAt, finished_at: finishedAt,
          timed_out: false, exit_code: null, signal: null,
          stdout_excerpt: "", stderr_excerpt: stderr.slice(0, MAX_CHECK_STDIO_EXCERPT),
        };
      }
      cwd = resolved.absolute;
    } else {
      cwd = workspaceRoot;
    }

    try {
      const result = execFileSync(cmd.argv[0]!, cmd.argv.slice(1), {
        cwd,
        timeout: cmd.timeout_ms,
        maxBuffer: MAX_CHECK_STDIO_EXCERPT,
        stdio: ["ignore", "pipe", "pipe"] as const,
      });
      exitCode = 0;
      stdout = result.stdout.toString("utf-8").slice(0, MAX_CHECK_STDIO_EXCERPT);
      stderr = result.stderr.toString("utf-8").slice(0, MAX_CHECK_STDIO_EXCERPT);
    } catch (err: unknown) {
      const e = err as ExecError;
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.code === "ETIMEDOUT") {
        timedOut = true;
      } else if (e.killed) {
        timedOut = true;
        signal = e.signal ?? null;
      } else {
        exitCode = e.status ?? null;
        signal = e.signal ?? null;
      }
      if (e.stdout) stdout = e.stdout.toString("utf-8").slice(0, MAX_CHECK_STDIO_EXCERPT);
      if (e.stderr) stderr = e.stderr.toString("utf-8").slice(0, MAX_CHECK_STDIO_EXCERPT);
    }

    return {
      check_id: cmd.id,
      argv: cmd.argv,
      cwd: cmd.cwd,
      started_at: startedAt,
      finished_at: finishedAt,
      timed_out: timedOut,
      exit_code: exitCode,
      signal,
      stdout_excerpt: stdout.slice(0, MAX_CHECK_STDIO_EXCERPT),
      stderr_excerpt: stderr.slice(0, MAX_CHECK_STDIO_EXCERPT),
    };
  });
}

function observeArtifacts(contract: WorkerAcceptanceContractV1, workspaceRoot: string | undefined): ArtifactObservation[] {
  return contract.expected_artifacts.map(a => {
    if (workspaceRoot === undefined) {
      return { artifact_id: a.id, exists: false, kind: a.kind, ref: a.ref, error: "workspace unavailable" };
    }
    const resolved = resolveWorkspaceMember(workspaceRoot, a.ref);
    if (resolved.kind !== "ok") {
      return {
        artifact_id: a.id,
        exists: false,
        kind: a.kind,
        ref: a.ref,
        error: resolved.kind === "escape" ? "path escapes workspace" : resolved.kind === "missing" ? "not found" : resolved.reason,
      };
    }
    try {
      const st = statSync(resolved.absolute);
      const digest = a.kind === "file"
        ? createHash("sha256").update(readFileSync(resolved.absolute)).digest("hex").slice(0, 16)
        : undefined;
      return {
        artifact_id: a.id,
        exists: true,
        kind: a.kind,
        ref: a.ref,
        size: st.size,
        digest: digest ? `sha256-${digest}` : undefined,
      };
    } catch (err) {
      return { artifact_id: a.id, exists: false, kind: a.kind, ref: a.ref, error: String(err) };
    }
  });
}

function deriveCriteria(
  contract: WorkerAcceptanceContractV1,
  checks: VerificationObservation[],
  artifacts: ArtifactObservation[],
): Array<{ criterion_id: string; status: CriterionStatus; evidence_ids: string[] }> {
  return contract.criteria.map(c => {
    const evidenceIds: string[] = [];
    let status: CriterionStatus = "not_run";

    const relevantChecks = checks.filter(ch => {
      const cmd = contract.verification_commands.find(vc => vc.id === ch.check_id);
      return cmd?.criterion_ids.includes(c.id);
    });

    const requiredArtifacts = artifacts.filter(a => {
      const ea = contract.expected_artifacts.find(ea => ea.id === a.artifact_id);
      return ea?.criterion_ids.includes(c.id) && ea.required;
    });

    if (relevantChecks.length > 0) {
      evidenceIds.push(...relevantChecks.map(ch => ch.check_id));
      const allChecksPassed = relevantChecks.every(ch => ch.exit_code === 0 && !ch.timed_out);
      status = allChecksPassed ? "passed" : "failed";
    }

    if (requiredArtifacts.length > 0) {
      evidenceIds.push(...requiredArtifacts.map(a => a.artifact_id));
      const allArtifactsExist = requiredArtifacts.every(a => a.exists);
      if (status === "not_run") {
        status = allArtifactsExist ? "passed" : "failed";
      } else if (!allArtifactsExist) {
        status = "failed";
      }
    }

    if (relevantChecks.length === 0 && requiredArtifacts.length === 0) {
      status = "inconclusive";
    }

    return { criterion_id: c.id, status, evidence_ids: evidenceIds };
  });
}

interface ExecError {
  code?: string | number;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  killed?: boolean;
  stdout?: Buffer;
  stderr?: Buffer;
}

function execFileSync(cmd: string, args: string[], opts: { cwd: string; timeout: number; maxBuffer: number; stdio: readonly ["ignore", "pipe", "pipe"] }): { stdout: Buffer; stderr: Buffer } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    stdio: opts.stdio as ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err: ExecError = {};
    err.code = result.status ?? undefined;
    err.status = result.status;
    err.signal = result.signal;
    err.stdout = result.stdout ?? undefined;
    err.stderr = result.stderr ?? undefined;
    throw err;
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
