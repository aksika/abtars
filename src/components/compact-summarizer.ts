/**
 * compact-summarizer.ts — provider-neutral conversation compaction summarizer
 * (#1406).
 *
 * Executes one bounded, ephemeral, tool-free summarization call through the
 * existing Pi-core provider composition (spin one-shot). It never hydrates the
 * source conversation as its own durable session and never imports a provider
 * SDK. Provider/model identity is resolved from the transport assignment for
 * content-free telemetry only.
 */

import type { Spin } from "./spin.js";
import { resolveAgent } from "./transport-config.js";
import { estimateTokensFromChars } from "./transport/token-budget.js";

/** Upper bound for custom compaction instructions (bytes). */
export const MAX_COMPACT_INSTRUCTIONS_BYTES = 4_000;
/** One-shot call timeout. */
export const COMPACTION_CALL_TIMEOUT_MS = 120_000;

// #1515: the marker is persisted only so abmind can correlate a delivered
// boot question in later transcripts. It is never part of provider input,
// including when an older daemon returns an unstripped compaction candidate.
const WAKE_UP_QUESTION_MARKER_RE = /(^|\n)([^\n]*\t[^\n]*\t)?\[WAKE-UP QUESTION id=[^\]\r\n]{1,128}\][ \t]*/gm;
function stripWakeUpQuestionMarkers(text: string): string {
  return text.replace(WAKE_UP_QUESTION_MARKER_RE, "$1$2");
}

export interface CompactionSummarizeInput {
  serializedTurns: string;
  priorCheckpoint: string;
  maxOutputTokens: number;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionSummarizeOutput {
  text: string;
  provider: string | null;
  model: string | null;
}

export interface ConversationCompactionSummarizer {
  summarize(input: CompactionSummarizeInput): Promise<CompactionSummarizeOutput>;
}

/**
 * Build the bounded one-shot summarization prompt. The source serialization
 * is bounded by the daemon (COMPACTION_PAYLOAD_MAX_BYTES); the summary must
 * reduce the source — enforced again at commit.
 */
export function buildCompactionPrompt(input: {
  serializedTurns: string;
  priorCheckpoint: string;
  maxOutputTokens: number;
  customInstructions?: string;
}): string {
  const parts: string[] = [
    "You are maintaining a durable cumulative checkpoint of a long conversation.",
    "Your task: condense the conversation source below into a concise, complete checkpoint summary.",
    "Requirements:",
    `- Keep the summary under ${input.maxOutputTokens} tokens.`,
    "- Preserve every distinct fact, decision, user preference, and unresolved task.",
    "- Never invent content that is not in the source.",
    "- Output ONLY the checkpoint summary text — no commentary, no headings.",
  ];
  if (input.customInstructions) {
    parts.push(`Additional focus for this compaction: ${input.customInstructions}`);
  }
  if (input.priorCheckpoint) {
    parts.push(`Prior checkpoint (already compacted history — build on it, do not repeat it):\n${stripWakeUpQuestionMarkers(input.priorCheckpoint)}`);
  }
  parts.push(`Conversation source:\n${stripWakeUpQuestionMarkers(input.serializedTurns)}`);
  return parts.join("\n\n");
}

export function createCompactionSummarizer(spin: Spin): ConversationCompactionSummarizer {
  let identity: { provider: string | null; model: string | null } | null = null;
  try {
    const agent = resolveAgent("coding") ?? resolveAgent("main");
    if (agent) identity = { provider: agent.providerName, model: agent.model };
  } catch { /* telemetry identity is best-effort */ }

  return {
    async summarize(input: CompactionSummarizeInput): Promise<CompactionSummarizeOutput> {
      if (input.signal?.aborted) {
        throw new Error("compaction summarization aborted before start");
      }
      const prompt = buildCompactionPrompt({
        serializedTurns: input.serializedTurns,
        priorCheckpoint: input.priorCheckpoint,
        maxOutputTokens: input.maxOutputTokens,
        customInstructions: input.customInstructions,
      });

      const result = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(new Error("compaction summarization aborted"));
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        spin.dispatchBackground({
          prompt,
          type: "S",
          timeoutMs: COMPACTION_CALL_TIMEOUT_MS,
          signal: input.signal,
        }).then(
          (text) => {
            if (settled) return;
            settled = true;
            resolve(text);
          },
          (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          },
        ).finally(() => {
          input.signal?.removeEventListener("abort", onAbort);
        });
      });

      const text = result.trim();
      if (text.length === 0) {
        throw new Error("compaction summarizer returned an empty result");
      }
      // Bounded inflation guard before commit (server revalidates).
      const summaryTokens = estimateTokensFromChars(text.length);
      const sourceTokens = estimateTokensFromChars(input.serializedTurns.length);
      if (summaryTokens >= sourceTokens) {
        throw new Error("compaction summary does not reduce the source");
      }
      return { text, provider: identity?.provider ?? null, model: identity?.model ?? null };
    },
  };
}
