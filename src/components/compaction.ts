/**
 * Compaction prompt and summary extraction.
 * Sends a compaction request to the current session, extracts the structured summary.
 */

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
  // Strip analysis
  let text = response.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  // Extract summary content
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match?.[1]) return match[1].trim();
  // No tags — use the whole response (model didn't follow format)
  return text;
}

export function getCompactionPrompt(): string {
  return COMPACTION_PROMPT;
}
