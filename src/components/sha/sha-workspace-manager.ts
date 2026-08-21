/**
 * sha-workspace-manager.ts — disposable SHA workspace containment (#1688
 * Task 5). Validates the fixed `sha` alias (explicit alias-level
 * projectTrust="never"), rejects canonical/live/protected roots, verifies a
 * clean Git checkout with a captured baseline commit, and resets/cleans only
 * the validated alias path before every stage. RCA/design must leave the
 * checkout unchanged; solution evidence is copied privately and the checkout
 * restored. All subprocesses use argv arrays, explicit cwd/timeout, bounded
 * capture, and no shell.
 */
import { execFile } from "node:child_process";
import { realpathSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { loadPiConfig } from "../pi-executor/config.js";
import type { PiExecutorConfig } from "../pi-executor/config.js";
import { abtarsHome, abtarsRoot } from "../../paths.js";
import { isPathWithinRoot } from "../workspace-paths.js";

export const SHA_WORKSPACE_ALIAS = "sha";

const GIT_TIMEOUT_MS = 30_000;
const MAX_EVIDENCE_BYTES = 1_048_576;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ExecFn = (cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number }) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 1_048_576 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? null : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export interface ShaWorkspaceManagerOptions {
  loadPiConfig?: () => PiExecutorConfig | null;
  exec?: ExecFn;
}

export type WorkspacePreflight =
  | { ok: true; canonicalPath: string; root: string | null; baselineCommit: string; clean: boolean }
  | { ok: false; error: string };

export type WorkspaceStageResult =
  | { ok: true }
  | { ok: false; error: string };

export class ShaWorkspaceManager {
  private readonly loadConfig: () => PiExecutorConfig | null;
  private readonly exec: ExecFn;

  constructor(opts: ShaWorkspaceManagerOptions = {}) {
    this.loadConfig = opts.loadPiConfig ?? loadPiConfig;
    this.exec = opts.exec ?? defaultExec;
  }

  /** Canonical protected roots: live checkout, home config/state/secrets/logs. */
  protectedRoots(): string[] {
    const roots: string[] = [];
    const live = abtarsRoot();
    if (live) roots.push(live);
    const home = abtarsHome();
    if (home) roots.push(home);
    // Best-effort canonicalization: a symlinked home/root must compare against
    // the realpath'd alias, or both-direction containment is blind to it.
    return roots.map((root) => {
      try { return realpathSync(root); } catch { return root; }
    });
  }

  /**
   * #1688 R7: resolve + preflight the fixed alias. Requires alias-level
   * projectTrust="never" (the global fallback is insufficient for this safety
   * contract), separator-aware containment, a clean Git checkout, and a
   * captured baseline commit.
   */
  async preflight(): Promise<WorkspacePreflight> {
    return this.resolve({ requireClean: true });
  }

  /**
   * #1688 R8: re-check the canonical workspace immediately before a known
   * fix command. This deliberately does not require a clean tree because a
   * verified action may be the operation that changes it.
   */
  async validateExecutionPath(expectedPath: string): Promise<WorkspaceStageResult> {
    let canonical: string;
    try {
      canonical = realpathSync(expectedPath);
    } catch {
      return { ok: false, error: `workspace path "${expectedPath}" no longer resolves` };
    }
    if (canonical !== expectedPath) {
      return { ok: false, error: `workspace path identity changed (${expectedPath} → ${canonical})` };
    }
    for (const protectedRoot of this.protectedRoots()) {
      if (canonical === protectedRoot || isPathWithinRoot(protectedRoot, canonical) || isPathWithinRoot(canonical, protectedRoot)) {
        return { ok: false, error: `workspace path intersects protected root "${protectedRoot}"` };
      }
    }
    return { ok: true };
  }

  /**
   * #1688 R8: commands may not smuggle an absolute or escaping path past the
   * workspace cwd. Bare Git refs remain valid; path-shaped arguments are
   * resolved against the validated checkout and must stay inside it.
   */
  validateCommand(argv: readonly string[], canonicalPath: string): WorkspaceStageResult {
    for (const arg of argv.slice(1)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (!value || value === "--") continue;
      const pathShaped = value.startsWith("/") || value.startsWith("~") || value === "." || value === ".."
        || value.startsWith("./") || value.startsWith("../") || value.includes("/");
      if (!pathShaped) continue;
      if (value.startsWith("~")) return { ok: false, error: `command argument "${arg}" uses a home-relative path` };
      const candidate = resolve(canonicalPath, value);
      if (!isPathWithinRoot(canonicalPath, candidate)) {
        return { ok: false, error: `command argument "${arg}" escapes the SHA workspace` };
      }
    }
    return { ok: true };
  }

  /**
   * #1688 R7: resolve the alias without the cleanliness requirement when a
   * stage has legitimately written its evidence artifact (solution copy,
   * post-stage postcondition checks). Identity/protected-root checks always
   * apply.
   */
  async resolve(opts: { requireClean?: boolean } = {}): Promise<WorkspacePreflight> {
    const config = this.loadConfig();
    if (!config) return { ok: false, error: "Pi executor is disabled — SHA stages require the configured Pi alias" };
    const mapping = config.workspaceAliases[SHA_WORKSPACE_ALIAS];
    if (!mapping) return { ok: false, error: `workspace alias "${SHA_WORKSPACE_ALIAS}" is not configured` };
    if (mapping.projectTrust !== "never") {
      return { ok: false, error: `alias "${SHA_WORKSPACE_ALIAS}" must set projectTrust="never" (global fallback is rejected for SHA)` };
    }
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(mapping.path);
    } catch {
      return { ok: false, error: `workspace path "${mapping.path}" does not exist` };
    }
    const st = statSync(canonicalPath);
    if (!st.isDirectory()) return { ok: false, error: `workspace path "${canonicalPath}" is not a directory` };

    if (!mapping.root) return { ok: false, error: `workspace alias "${SHA_WORKSPACE_ALIAS}" must configure a containing root` };
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(mapping.root);
    } catch {
      return { ok: false, error: `configured root "${mapping.root}" not found` };
    }
    if (!statSync(canonicalRoot).isDirectory()) return { ok: false, error: `configured root "${canonicalRoot}" is not a directory` };
    if (canonicalRoot === canonicalPath || !isPathWithinRoot(canonicalRoot, canonicalPath)) {
      return { ok: false, error: `workspace path must be strictly inside configured root "${canonicalRoot}"` };
    }
    const root: string | null = canonicalRoot;

    // Protected-root rejection in both directions: the alias may not live
    // inside a protected root, and no protected root may live inside the
    // alias (a reset would then be destructive).
    for (const protectedRoot of this.protectedRoots()) {
      if (canonicalPath === protectedRoot) {
        return { ok: false, error: `workspace path equals protected root "${protectedRoot}"` };
      }
      if (isPathWithinRoot(protectedRoot, canonicalPath)) {
        return { ok: false, error: `workspace path is inside protected root "${protectedRoot}"` };
      }
      if (isPathWithinRoot(canonicalPath, protectedRoot)) {
        return { ok: false, error: `workspace path contains protected root "${protectedRoot}"` };
      }
    }

    const status = await this.gitStatus(canonicalPath);
    if (!status.ok) return status;
    if (opts.requireClean !== false && status.porcelain.length > 0) {
      return { ok: false, error: `workspace is dirty (${status.porcelain.length} entry/ies) — SHA requires a clean dedicated checkout` };
    }
    const commit = await this.gitHead(canonicalPath);
    if (!commit.ok) return commit;
    return { ok: true, canonicalPath, root, baselineCommit: commit.commit, clean: true };
  }

  /**
   * #1688 R7: reset/clean ONLY the validated alias path to the captured
   * baseline and remove prior generated content. Re-resolves canonical
   * identity immediately before the destructive Git commands.
   */
  async prepareStage(preflight: Extract<WorkspacePreflight, { ok: true }>): Promise<WorkspaceStageResult> {
    const identity = await this.revalidateIdentity(preflight.canonicalPath, preflight.baselineCommit);
    if (!identity.ok) return identity;
    const reset = await this.exec("git", ["reset", "--hard", preflight.baselineCommit], { cwd: preflight.canonicalPath, timeoutMs: GIT_TIMEOUT_MS });
    if (reset.code !== 0) {
      return { ok: false, error: `git reset failed: ${(reset.stderr || reset.stdout).slice(0, 300)}` };
    }
    // #1688 review: revalidate immediately before the second destructive
    // command as well — a path swap between reset and clean is refused.
    const identityAgain = await this.revalidateIdentity(preflight.canonicalPath, preflight.baselineCommit);
    if (!identityAgain.ok) return identityAgain;
    const clean = await this.exec("git", ["clean", "-fd"], { cwd: preflight.canonicalPath, timeoutMs: GIT_TIMEOUT_MS });
    if (clean.code !== 0) {
      return { ok: false, error: `git clean failed: ${(clean.stderr || clean.stdout).slice(0, 300)}` };
    }
    return { ok: true };
  }

  /** #1688 R7: RCA/design must leave the checkout unchanged. */
  async assertAnalysisClean(preflight: Extract<WorkspacePreflight, { ok: true }>): Promise<WorkspaceStageResult> {
    return this.assertAnalysisCleanExcluding(preflight, []);
  }

  /** #1688 R7: zero-diff check that treats the sanctioned stage artifacts
   *  (the evidence files the Worker must produce) as the one permitted write. */
  async assertAnalysisCleanExcluding(
    preflight: Extract<WorkspacePreflight, { ok: true }>,
    excludedRefs: readonly string[],
  ): Promise<WorkspaceStageResult> {
    const identity = await this.revalidateIdentity(preflight.canonicalPath, preflight.baselineCommit);
    if (!identity.ok) return identity;
    const status = await this.gitStatus(preflight.canonicalPath);
    if (!status.ok) return status;
    const excluded = new Set(excludedRefs.map((r) => r.replace(/^\.\//, "")));
    const mutation = status.porcelain.filter((line) => {
      const path = line.slice(3).trim().replace(/\/+$/, "");
      // The sanctioned artifact (or any directory containing it) is the one
      // permitted write; everything else counts as a mutation.
      const isAllowed = [...excluded].some((e) => e === path || e.startsWith(path + "/") || path.startsWith(e + "/"));
      return !isAllowed;
    });
    if (mutation.length > 0) {
      return { ok: false, error: `analysis stage mutated the workspace: ${mutation.slice(0, 5).join("; ")}` };
    }
    return { ok: true };
  }

  /**
   * #1688 R7: copy bounded solution evidence into the private incident
   * evidence directory (600 perms). The disposable checkout is restored by
   * the coordinator's next-stage `prepareStage`.
   */
  async copyEvidence(preflight: Extract<WorkspacePreflight, { ok: true }>, incidentId: number, stage: string, artifactPath: string): Promise<WorkspaceStageResult> {
    const identity = await this.revalidateIdentity(preflight.canonicalPath, preflight.baselineCommit);
    if (!identity.ok) return identity;
    const evidenceDir = join(abtarsHome(), "state", "sha", "incidents", String(incidentId), stage);
    try {
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      // Source containment: the artifact path is worker-authored — resolve and
      // require it to stay inside the disposable checkout before reading.
      let source: string;
      try {
        source = realpathSync(artifactPath);
      } catch {
        return { ok: false, error: `evidence source "${artifactPath}" does not resolve` };
      }
      if (!isPathWithinRoot(preflight.canonicalPath, source)) {
        return { ok: false, error: `evidence source escapes the SHA workspace` };
      }
      const content = readFileSync(source, "utf-8");
      if (Buffer.byteLength(content, "utf-8") > MAX_EVIDENCE_BYTES) {
        return { ok: false, error: `evidence "${source}" exceeds the 1 MiB bound` };
      }
      const target = join(evidenceDir, basename(source));
      if (!isPathWithinRoot(evidenceDir, target)) return { ok: false, error: "evidence path escapes its directory" };
      writeFileSync(target, content, { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `evidence copy failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  /**
   * #1688 R7: re-resolve canonical identity immediately before any
   * destructive operation; refuse on mismatch (TOCTOU guard).
   */
  private async revalidateIdentity(expectedPath: string, expectedCommit: string): Promise<WorkspaceStageResult> {
    let canonical: string;
    try {
      canonical = realpathSync(expectedPath);
    } catch {
      return { ok: false, error: `workspace path "${expectedPath}" no longer resolves — destructive operation refused` };
    }
    if (canonical !== expectedPath) {
      return { ok: false, error: `workspace path identity changed (${expectedPath} → ${canonical}) — destructive operation refused` };
    }
    for (const protectedRoot of this.protectedRoots()) {
      if (canonical === protectedRoot || isPathWithinRoot(protectedRoot, canonical) || isPathWithinRoot(canonical, protectedRoot)) {
        return { ok: false, error: `workspace path now intersects protected root "${protectedRoot}" — destructive operation refused` };
      }
    }
    const head = await this.gitHead(canonical);
    if (!head.ok) return head;
    if (head.commit !== expectedCommit) {
      return { ok: false, error: `workspace HEAD moved (${expectedCommit} → ${head.commit}) — reset refused` };
    }
    return { ok: true };
  }

  private async gitStatus(cwd: string): Promise<{ ok: true; porcelain: string[] } | { ok: false; error: string }> {
    try {
      const st = statSync(join(cwd, ".git"));
      if (!st.isDirectory()) return { ok: false, error: "workspace is not a Git checkout" };
    } catch {
      return { ok: false, error: "workspace is not a Git checkout" };
    }
    const result = await this.exec("git", ["status", "--porcelain"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) {
      return { ok: false, error: `git status failed: ${(result.stderr || result.stdout).slice(0, 300)}` };
    }
    const porcelain = result.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return { ok: true, porcelain };
  }

  private async gitHead(cwd: string): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
    const result = await this.exec("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) {
      return { ok: false, error: `git rev-parse failed: ${(result.stderr || result.stdout).slice(0, 300)}` };
    }
    return { ok: true, commit: result.stdout.trim() };
  }
}
