import { describe, it, expect } from "vitest";
import { pruneToolResults, type PrunableMessage } from "./tool-result-pruner.js";

describe("pruneToolResults", () => {
  const makeMessages = (count: number): PrunableMessage[] => {
    const msgs: PrunableMessage[] = [];
    for (let i = 0; i < count; i++) {
      if (i % 3 === 0) msgs.push({ role: "user", content: `User message ${i}` });
      else if (i % 3 === 1) msgs.push({ role: "assistant", content: `Assistant ${i}`, tool_calls: [{ id: `tc_${i}`, function: { name: "terminal", arguments: `{"command":"echo ${i}"}` } }] });
      else msgs.push({ role: "tool", content: `Result ${i}\n${"line content\n".repeat(50)}end`, tool_call_id: `tc_${i - 1}` });
    }
    return msgs;
  };

  it("clears tool results outside tail to one-liner", () => {
    const msgs = makeMessages(30);
    const { messages, prunedCount } = pruneToolResults(msgs, 12, false);
    // Messages outside tail (first 18) with tool role should be one-liners
    const outsideTail = messages.slice(0, 18).filter(m => m.role === "tool");
    for (const m of outsideTail) {
      expect(m.content).toMatch(/\[tool:\w+\] \(cleared, was \d+ch\)/);
    }
    expect(prunedCount).toBeGreaterThan(0);
  });

  it("soft-trims tool results inside tail", () => {
    const msgs = makeMessages(30);
    const { messages } = pruneToolResults(msgs, 12, false);
    // Messages inside tail (last 12) with tool role should be soft-trimmed
    const insideTail = messages.slice(-12).filter(m => m.role === "tool");
    for (const m of insideTail) {
      expect(m.content.length).toBeLessThan(5000);
      expect(m.content).toContain("trimmed");
    }
  });

  it("deduplicates identical tool results", () => {
    const msgs: PrunableMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "x".repeat(500), tool_call_id: "a" },
      { role: "user", content: "again" },
      { role: "tool", content: "x".repeat(500), tool_call_id: "b" }, // same content
      { role: "user", content: "latest" },
    ];
    const { messages } = pruneToolResults(msgs, 3, false);
    // First (older) duplicate should be [dup]
    expect(messages[1]!.content).toBe("[dup]");
    // Second (newer) keeps content (or gets pruned by position)
    expect(messages[3]!.content).not.toBe("[dup]");
  });

  it("aggressive mode clears ALL tool results outside tail", () => {
    const msgs = makeMessages(30);
    const { messages } = pruneToolResults(msgs, 12, true);
    const outsideTail = messages.slice(0, 18).filter(m => m.role === "tool");
    for (const m of outsideTail) {
      expect(m.content.length).toBeLessThan(100);
    }
  });

  it("truncates large tool_call arguments", () => {
    const msgs: PrunableMessage[] = [
      { role: "assistant", content: "ok", tool_calls: [{ id: "tc1", function: { name: "write_file", arguments: JSON.stringify({ path: "x", content: "y".repeat(1000) }) } }] },
      { role: "tool", content: "done", tool_call_id: "tc1" },
      ...Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `msg ${i}` })),
    ];
    const { messages } = pruneToolResults(msgs, 12, false);
    const args = messages[0]!.tool_calls![0]!.function.arguments;
    expect(args.length).toBeLessThan(500);
    expect(JSON.parse(args)).toBeDefined(); // still valid JSON
  });
});
