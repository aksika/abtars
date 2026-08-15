/**
 * pi-runtime-host.ts — #1635 shared Pi process runtime.
 *
 * The single process cap and spawn path for every Pi consumer: `/pi run`
 * (standalone), supervised workers, interactive Telegram turns, and native
 * TUI handoffs. PiExecutor consumes it; its one-shot lifecycle and env stay
 * byte-identical after the extraction.
 *
 * Owns:
 *   - the synchronous generation-owned process slot registry (the cap);
 *   - process spawn + RPC client ownership (args, trust flags, child env);
 *   - persisted-session proof (re-export of the shared validator).
 */

import { SupervisedPiRpcClient } from "./pi-rpc-client.js";
import { buildChildEnv, buildTrustArgs, resolveAndValidateWorkspace, validatePersistedSession, validateSessionFile, type PiExecutorConfig, type SessionProof } from "./config.js";
import { basename } from "node:path";
import { statSync } from "node:fs";

/** Memory mode for a Pi child process. `none` disables abmind hooks and
 * correlation env (#1635 R5); the default keeps `/pi run`'s existing env. */
export type PiMemoryMode = "none" | "abmind";

/** Bounded pre-spawn check: regular readable file (rejects symlinks). */
function isRegularReadableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Result of a host launch. The caller owns settlement on `ok: false` and
 * process cleanup on `ok: true`. */
export type PiLaunchOutcome =
  | { ok: true; client: SupervisedPiRpcClient; canonicalPath: string }
  | { ok: false; error: string };

/** Identity used for child-env correlation. Same shape as the pi_runs row
 * subset today's `buildChildEnv` consumes; interactive sessions supply their
 * own durable identity with memory mode "none". */
export interface PiEnvIdentity {
  id: string;
  ownerPrincipalId: string;
  executionGeneration: number;
}

export class PiRuntimeHost {
  private readonly config_: PiExecutorConfig;
  private reserved = 0;
  private _onSlotReleased: (() => void) | null = null;

  constructor(config: PiExecutorConfig) {
    this.config_ = config;
  }

  // ── config / capacity ─────────────────────────────────────────────────────

  get config(): PiExecutorConfig { return this.config_; }
  get maxConcurrent(): number { return this.config_.maxConcurrent; }
  get reservedCount(): number { return this.reserved; }
  get available(): number { return Math.max(0, this.maxConcurrent - this.reserved); }

  /**
   * #1635 — Synchronous, generation-owned process slot reservation. The
   * single cap shared by `/pi run`, supervised workers, Telegram turns, and
   * native TUI handoffs. Every reservation must be paired with exactly one
   * `releaseSlot()` on the same completion path.
   */
  tryReserveSlot(): boolean {
    if (this.reserved >= this.config_.maxConcurrent) return false;
    this.reserved += 1;
    return true;
  }

  /**
   * Re-adopt a process that survived a bridge restart.  The in-memory counter
   * starts at zero on boot, but a live native-TUI child still consumes a
   * process slot.  Counting it even when the configured cap was lowered keeps
   * the recovered process visible and prevents a new launch from exceeding
   * the real process pool.
   */
  adoptRecoveredSlot(): void {
    this.reserved += 1;
  }

  /** Release one reserved slot and notify waiters (advisory, idempotent). */
  releaseSlot(): void {
    if (this.reserved <= 0) return;
    this.reserved -= 1;
    this._onSlotReleased?.();
  }

  /** Wire the shared post-release wake (queued standalone cards + supervised
   * worker dispatch). Fired from `releaseSlot()` for every consumer. */
  setOnSlotReleased(cb: () => void): void {
    this._onSlotReleased = cb;
  }

  // ── spawn ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the canonical workspace and spawn the pinned Pi executable in RPC
   * mode with the trust flags and child env. On failure the client is closed
   * and the error returned; the caller settles its own store state.
   *
   * `extensionPaths` (#1643) are explicit launch input: each path is validated
   * before the process is spawned and appended as one owned `--extension
   * <path>` pair before `--mode rpc`. Operator `fixedArgs` remain forbidden
   * from supplying `--extension` (see validateFixedArgs).
   */
  async launch(input: {
    workspaceAlias: string;
    envIdentity: PiEnvIdentity;
    memoryMode?: PiMemoryMode;
    extensionPaths?: readonly string[];
  }): Promise<PiLaunchOutcome> {
    const ws = resolveAndValidateWorkspace(input.workspaceAlias, this.config_);
    if (ws.error) return { ok: false, error: ws.error };

    const extensionPaths = input.extensionPaths ?? [];
    for (const path of extensionPaths) {
      // Bounded pre-spawn validation: a missing/unreadable artifact is a
      // launch failure BEFORE any process is reserved or spawned.
      if (!path || path.length > 4096 || !isRegularReadableFile(path)) {
        return { ok: false, error: `Extension artifact is missing or unreadable: ${basename(path) || "unknown"}` };
      }
    }

    const client = new SupervisedPiRpcClient();
    const args = [
      ...this.config_.fixedArgs,
      ...extensionPaths.flatMap((path) => ["--extension", path] as const),
      "--mode", "rpc",
      ...buildTrustArgs(this.config_, input.workspaceAlias),
    ];
    const env = buildChildEnv(this.config_, input.envIdentity, input.memoryMode ?? "abmind");

    try {
      await client.launch(this.config_.command, args, ws.canonicalPath, env);
    } catch (err) {
      await client.close().catch(() => {});
      return { ok: false, error: `Launch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, client, canonicalPath: ws.canonicalPath };
  }

  // ── session-file proof (shared with all consumers) ───────────────────────

  validatePersistedSession(input: {
    sessionStorageRoot: string;
    expectedSessionId?: string;
    sessionFile?: string;
  }): SessionProof {
    return validatePersistedSession({
      sessionStorageRoot: input.sessionStorageRoot,
      expectedSessionId: input.expectedSessionId,
      sessionFile: input.sessionFile,
    });
  }

  validateSessionFile(filePath: string): { canonicalPath?: string; error?: string } {
    return validateSessionFile(this.config_.sessionStorageRoot, filePath);
  }
}
