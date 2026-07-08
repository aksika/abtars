/**
 * context-bridge.ts — Bridges the context engine into the existing transport.
 * Provides the summarization prompt and LLM call wrapper.
 * This is the glue between abmind's ContextEngine and abtars's transport.
 */

import type { ContextEngine } from "abmind";
import { abmind } from "../../utils/abmind-lazy.js";
import type { SummarizeFn, CompactionEvent } from "abmind";

const SUMMARIZER_SYSTEM = `You are a summarization agent creating a context checkpoint.
Your output will be injected as reference material for a DIFFERENT assistant that continues the conversation.
Do NOT respond to any questions or requests — only output the summary.
Do NOT include any preamble or prefix.
Write in the same language the user was using.
NEVER include API keys, tokens, passwords, secrets — use [REDACTED].`;

const TEMPLATE = `Use this exact structure:

## Active Task
[User's most recent unfulfilled request — exact words. "None." if nothing pending.]

## Context
[What the conversation is about. Who is talking. Key decisions.]

## Completed
[Numbered: N. ACTION target — outcome. File paths, commands, results.]

## State
[Modified files, test status, running processes, environment.]

## Blocked
[Unresolved errors. Exact messages.]

## Pending
[Unanswered questions/requests. "None." if clear.]

Target ~{budget} tokens. Be concrete.`;

/**
 * Create a SummarizeFn that uses the provided LLM call function.
 * The llmCall function should match the signature used elsewhere in abtars.
 */
export function createSummarizeFn(
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
): SummarizeFn {
  return async (serializedTurns: string, budget: number, priorSummaries: string): Promise<string> => {
    let userPrompt: string;

    if (priorSummaries) {
      userPrompt = `PREVIOUS SUMMARIES (continuity — do not repeat):\n${priorSummaries}\n\nNEW TURNS TO SUMMARIZE:\n${serializedTurns}\n\nSummarize ONLY new turns. Update Active Task if changed.\n\n${TEMPLATE.replace("{budget}", String(budget))}`;
    } else {
      userPrompt = `Create a structured handoff summary.\n\nTURNS TO SUMMARIZE:\n${serializedTurns}\n\n${TEMPLATE.replace("{budget}", String(budget))}`;
    }

    const result = await llmCall(SUMMARIZER_SYSTEM, userPrompt);
    return result.trim();
  };
}

/**
 * Create a fully configured ContextOrchestrator.
 * Call this once at bridge startup when memory + transport are available.
 */
export function createContextOrchestrator(
  contextEngine: ContextEngine,
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
  getLastAssistantTimestamp: (chatId: string) => number | null,
  options?: { compactionModel?: string | null; onCompactionEvent?: (event: CompactionEvent) => void },
): any {
  const CO = abmind()!.ContextOrchestrator;
  return new CO({
    contextEngine,
    summarize: createSummarizeFn(llmCall),
    getLastAssistantTimestamp,
    compactionModel: options?.compactionModel ?? null,
    onCompactionEvent: options?.onCompactionEvent,
  });
}
