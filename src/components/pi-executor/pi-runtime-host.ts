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

/** Memory mode for a Pi child process. `none` disables abmind hooks and
 * correlation env (#1635 R5); the default keeps `/pi run`'s existing env. */
export type PiMemoryMode = "none" | "abmind";

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
   */
  async launch(input: {
    workspaceAlias: string;
    envIdentity: PiEnvIdentity;
    memoryMode?: PiMemoryMode;
  }): Promise<PiLaunchOutcome> {
    const ws = resolveAndValidateWorkspace(input.workspaceAlias, this.config_);
    if (ws.error) return { ok: false, error: ws.error };

    const client = new SupervisedPiRpcClient();
    const args = [
      ...this.config_.fixedArgs,
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
