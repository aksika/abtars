/**
 * sealed-secret-handles.ts — execution-scoped opaque handles for sealed
 * credentials (#1660).
 *
 * A handle is an unguessable `secret:<base64url>` token bound to one active
 * Main execution, the owner user id, a memory id and its semantic revision.
 * Bindings live only in memory, expire on a short TTL, are deleted on
 * execution settlement/cancel/timeout, and fail closed on any owner/execution/
 * revision mismatch. Wrong, expired or forged handles all resolve to the same
 * null so callers cannot distinguish them.
 */

import { randomBytes } from "node:crypto";

const HANDLE_PREFIX = "secret:";
const HANDLE_BYTES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface HandleBinding {
  readonly executionId: string;
  readonly userId: string;
  readonly memoryId: number;
  readonly semanticRevision: number;
  readonly expiresAt: number;
}

export interface HandleIssueInput {
  executionId: string;
  userId: string;
  memoryId: number;
  semanticRevision: number;
  /** Bound to one active execution — never cross-execution. */
  ttlMs?: number;
}

export class SealedSecretHandles {
  private readonly bindings = new Map<string, HandleBinding>();

  /** Issue a new handle for the given execution/owner/revision tuple. */
  issue(input: HandleIssueInput): string {
    if (!input.executionId || !input.userId || input.memoryId < 1 || input.semanticRevision < 1) {
      throw new Error("sealed handle requires execution id, owner, memory id and revision");
    }
    const token = HANDLE_PREFIX + randomBytes(HANDLE_BYTES).toString("base64url");
    this.bindings.set(token, {
      executionId: input.executionId,
      userId: input.userId,
      memoryId: input.memoryId,
      semanticRevision: input.semanticRevision,
      expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
    });
    return token;
  }

  /**
   * Resolve a handle for the same active execution and owner. Returns null
   * for forged, expired, wrong-owner and wrong-execution handles alike.
   */
  lookup(token: string, ctx: { executionId: string; userId: string }): HandleBinding | null {
    if (!token.startsWith(HANDLE_PREFIX)) return null;
    const binding = this.bindings.get(token);
    if (!binding) return null;
    if (binding.executionId !== ctx.executionId || binding.userId !== ctx.userId) return null;
    if (binding.expiresAt <= Date.now()) {
      this.bindings.delete(token);
      return null;
    }
    return binding;
  }

  /** Delete every binding of an execution (settlement, cancel, timeout). */
  revokeExecution(executionId: string): number {
    let revoked = 0;
    for (const [token, binding] of this.bindings) {
      if (binding.executionId === executionId) {
        this.bindings.delete(token);
        revoked++;
      }
    }
    return revoked;
  }

  /** Drop all bindings (session/transport close). */
  clear(): void {
    this.bindings.clear();
  }

  get size(): number {
    return this.bindings.size;
  }
}
