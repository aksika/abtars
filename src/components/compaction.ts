/**
 * Compaction prompt, summary extraction, and shared compaction flow.
 */

import { logInfo } from "./logger.js";
import { buildMemoryContext } from "../memory/session-memory.js";
import type { IKiroTransport } from "./kiro-transport.js";
import type { MemoryManager } from "../memory/memory-manager.js";

const TAG = "compaction";

const COMPACTION_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and will waste your only turn.

Your task is to create a detailed summary of the conversation so far. This summary will replace the current context — everything before it will be gone. Be thorough.

Before your summary, wrap your analysis in <analysis> tags (this will be stripped — use it as a scratchpad).

Then provide your summary in <summary> tags with these sections:

1. **User's Requests and Intent**: What the user explicitly asked for, in detail
2. **Key Decisions**: Important decisions made during the conversation
3. **Technical Context**: Files, code, concepts, configurations discussed
4. **Errors and Fixes**: Problems encountered and how they were resolved
5. **User Messages**: All significant user messages (preserves intent drift)
6. **Pending Tasks**: Anything explicitly asked for but not yet done
7. **Current Work**: What was being worked on immediately before this summary
8. **Next Step**: The immediate next action, with direct quotes from recent messages

Example format:
<analysis>
[Your thought process]
</analysis>

<summary>
1. User's Requests and Intent:
   [Detailed description]

2. Key Decisions:
   - [Decision 1]

3. Technical Context:
   - [File/concept and why it matters]

4. Errors and Fixes:
   - [Error]: [How fixed]

5. User Messages:
   - [Key user message]

6. Pending Tasks:
   - [Task]

7. Current Work:
   [What was happening right before compaction]

8. Next Step:
   [Next action with quotes]
</summary>

REMINDER: Do NOT call any tools. Respond with plain text only.`;

/** Extract <summary> content, strip <analysis>. */
export function extractSummary(response: string): string {
  let text = response.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match?.[1]) return match[1].trim();
  return text;
}

export function getCompactionPrompt(): string {
  return COMPACTION_PROMPT;
}

/** Run full compaction: prompt → extract → reset → inject. Returns true on success. */
export async function runCompaction(
  transport: IKiroTransport,
  sessionKey: string,
  memory: MemoryManager | null,
  memoryDir: string,
): Promise<boolean> {
  const response = await transport.sendPrompt(sessionKey, COMPACTION_PROMPT);
  const summary = extractSummary(response ?? "");
  if (!summary || summary.length < 50) throw new Error("Summary too short");

  const memCtx = buildMemoryContext(memory, memoryDir);
  await transport.resetSession(sessionKey);

  const injection = `This session continues from a compacted conversation.\n\n${summary}${memCtx ? "\n\n" + memCtx : ""}`;
  await transport.sendPrompt(sessionKey, injection);

  logInfo(TAG, `Compaction done — summary ${summary.length} chars, memory ${memCtx.length} chars`);
  return true;
}
