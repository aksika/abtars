/**
 * Compaction — summarize user conversation, reset session, inject summary on next start.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo } from "./logger.js";
import { agentBridgeHome } from "../paths.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

const TAG = "compaction";

/** In-memory store for compaction summaries. Keyed by sessionKey. */
export const compactionSummaries = new Map<string, string>();

function loadCompactionPrompt(): string {
  try {
    return readFileSync(join(process.cwd(), "persona", "prompts", "compaction.md"), "utf-8").trim();
  } catch {
    // Fallback for deployed path
    try {
      return readFileSync(join(agentBridgeHome(), "persona", "prompts", "compaction.md"), "utf-8").trim();
    } catch {
      return "Summarize the conversation so far in <summary> tags. TEXT ONLY, no tool calls.";
    }
  }
}

/** Extract <summary> content, strip <analysis>. Returns null if invalid. */
export function extractSummary(response: string): string | null {
  const text = response.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summary = match?.[1]?.trim();
  if (!summary || summary.length < 50) return null;
  return summary;
}

/** Run compaction: prompt → extract → store summary → reset session. */
export async function runCompaction(
  transport: IKiroTransport,
  sessionKey: string,
  pendingSessionStart: Set<string>,
): Promise<boolean> {
  const prompt = loadCompactionPrompt();
  const response = await transport.sendPrompt(sessionKey, prompt);
  const summary = extractSummary(response ?? "");
  if (!summary) throw new Error("Compaction failed — no valid <summary> in response");

  compactionSummaries.set(sessionKey, summary);
  await transport.resetSession(sessionKey);
  pendingSessionStart.add(sessionKey);

  logInfo(TAG, `Compaction done — ${summary.length} chars summary stored for ${sessionKey}`);
  return true;
}
