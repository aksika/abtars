import { createHash } from "node:crypto";

/**
 * Request-scoped SOUL bundle envelope (#1932/R3).
 *
 * The envelope marks exactly one current bundle at the single projection
 * point used for conversational provider requests. Gate admission and the
 * summarizer/history exclusions are enforced elsewhere; this module is only
 * the content-free envelope identity. The raw bundle is never duplicated.
 */

export const SOUL_BUNDLE_MARKER_OPEN = "[ABTARS-SOUL-BUNDLE";
export const SOUL_BUNDLE_MARKER_CLOSE = "[/ABTARS-SOUL-BUNDLE]";

export interface SoulBundleEnvelopeInput {
  executionId: string;
  beforeMessageId?: number;
}

/** Keep the request identifier one safe line: hash anything unexpected. */
function envelopeRequestId(executionId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) return executionId;
  return createHash("sha256").update(executionId, "utf8").digest("hex").slice(0, 16);
}

function sourceBundleHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex").slice(0, 16);
}

/**
 * Wrap an already-assembled bundle in exactly one marked request envelope.
 * The source hash changes when refreshed bundle content changes; the cursor
 * identifies the durable history position (or an explicitly ephemeral turn).
 */
export function soulBundleEnvelope(systemPrompt: string, input: SoulBundleEnvelopeInput): string {
  const request = envelopeRequestId(input.executionId);
  const source = sourceBundleHash(systemPrompt);
  const cursor = typeof input.beforeMessageId === "number" ? String(input.beforeMessageId) : "ephemeral";
  return `${SOUL_BUNDLE_MARKER_OPEN} id=${request} bundle=${source} cursor=${cursor}]\n${systemPrompt}\n${SOUL_BUNDLE_MARKER_CLOSE}`;
}
