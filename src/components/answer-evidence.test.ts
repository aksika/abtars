/**
 * #1913 — answer evidence and answer records.
 *
 * Each test names the production invariant it protects; all run against the
 * real module with no mocks except the feedback runtime boundary.
 */
import { describe, it, expect } from "vitest";
import {
  beginAnswerSend,
  resolveReactionAnswer,
  recordDeliveredRecall,
  recordToolEvidence,
  takeToolEvidence,
  validateSupportIds,
  resolveAnswerSupport,
  publishAnswerRecord,
  lookupAnswerRecord,
  recordFeedbackBatch,
  recordReactionFeedback,
  formatFeedbackOutcome,
  isExecutionOverlapError,
  ANSWER_RECORD_TTL_MS,
} from "./answer-evidence.js";

describe("#1913 answer evidence", () => {
  it("validates declarations against host-observed evidence only", () => {
    // Forged/stale IDs degrade to the eligible subset, never authorize writes.
    expect(validateSupportIds([7, 999, 7, -3, 0], new Set([7]))).toEqual([7]);
    expect(validateSupportIds([999], new Set([7]))).toEqual([]);
  });

  it("unions declaration and heuristic support over injected and tool evidence", () => {
    // Tool-only answer: declared tool ID validates without any injection.
    expect(resolveAnswerSupport({ declared: [7], heuristic: [], autoInjected: [], toolDelivered: new Map([[7, 1]]) })).toEqual([7]);
    // Heuristic citation of an injected memory joins the declaration.
    expect(resolveAnswerSupport({ declared: [7], heuristic: [8], autoInjected: [7, 8], toolDelivered: new Map() })).toEqual([7, 8]);
    // Neither path rescues an ID nobody delivered.
    expect(resolveAnswerSupport({ declared: [9], heuristic: [9], autoInjected: [7], toolDelivered: new Map([[8, 1]]) })).toEqual([]);
  });

  it("isolates tool evidence per execution and drains once", () => {
    recordToolEvidence("e1", [{ memoryId: 7 }, { memoryId: -2 }, {}], 1_000);
    recordToolEvidence("e2", [{ memoryId: 9 }], 1_000);
    expect([...takeToolEvidence("e1", 1_001).keys()]).toEqual([7]);
    // Drained: a second take finds nothing (no double attribution).
    expect(takeToolEvidence("e1", 1_002).size).toBe(0);
    expect([...takeToolEvidence("e2", 1_003).keys()]).toEqual([9]);
  });

  it("aliases every delivered chunk to one answer record", () => {
    publishAnswerRecord(
      { platform: "telegram", channelId: "chat1", principal: "user1", sessionId: "s1", executionId: "e1", support: [7, 8], messageIds: ["m1", "m2"] },
      1_000,
    );
    expect(lookupAnswerRecord("telegram", "chat1", "m1", 1_001)?.support).toEqual([7, 8]);
    expect(lookupAnswerRecord("telegram", "chat1", "m2", 1_001)?.support).toEqual([7, 8]);
  });

  it("misses safely: unknown IDs, other chats, and expired records", () => {
    // Unique IDs per test: the stores are process-local and shared.
    publishAnswerRecord(
      { platform: "telegram", channelId: "chatX", principal: "user1", sessionId: "s1", executionId: "e1", support: [7], messageIds: ["mx"] },
      1_000,
    );
    expect(lookupAnswerRecord("telegram", "chatX", "nope", 1_001)).toBeUndefined();
    expect(lookupAnswerRecord("telegram", "chatY", "mx", 1_001)).toBeUndefined();
    expect(lookupAnswerRecord("telegram", "chatX", "mx", 1_000 + ANSWER_RECORD_TTL_MS + 1)).toBeUndefined();
  });

  it("never publishes support-free records", () => {
    publishAnswerRecord(
      { platform: "telegram", channelId: "chat1", principal: "user1", sessionId: "s1", executionId: "e1", support: [], messageIds: ["m9"] },
      1_000,
    );
    expect(lookupAnswerRecord("telegram", "chat1", "m9", 1_001)).toBeUndefined();
  });

  it("separates applied, rejected, and unknown feedback per target", async () => {
    const runtime = {
      recordFeedback: async (input: { memoryId: number }) => {
        if (input.memoryId === 1) return undefined;
        if (input.memoryId === 2) throw Object.assign(new Error("Memory no longer belongs to the user"), { code: "unauthorized" });
        throw new Error("socket hang up");
      },
    };
    const outcome = await recordFeedbackBatch(runtime, "user1", "cite", [
      { memoryId: 1, operationKey: "k1" },
      { memoryId: 2, operationKey: "k2" },
      { memoryId: 3, operationKey: "k3" },
    ]);
    expect(outcome).toEqual({ applied: [1], rejected: [2], unknown: [3] });
    expect(formatFeedbackOutcome(outcome)).toBe("1 applied, 1 rejected, 1 unknown");
  });

  it("detects execution overlap without matching ordinary failures", () => {
    expect(isExecutionOverlapError(new Error("Pi execution already active — overlapping sendPrompt rejected"))).toBe(true);
    expect(isExecutionOverlapError(Object.assign(new Error("busy"), { name: "SpinDispatchAdmissionError", code: "type_busy" }))).toBe(true);
    expect(isExecutionOverlapError(new Error("credits exhausted"))).toBe(false);
    expect(isExecutionOverlapError(undefined)).toBe(false);
    expect(isExecutionOverlapError(Object.assign(new Error("busy"), { name: "SpinDispatchAdmissionError", code: "session_capacity" }))).toBe(false);
  });
});


describe("#1913 review regressions", () => {
  it("defers a reaction until the current send has registered its target", async () => {
    const complete = beginAnswerSend("telegram", "pending-chat");
    const reaction = resolveReactionAnswer("telegram", "pending-chat", "pending-msg");
    publishAnswerRecord({ platform: "telegram", channelId: "pending-chat", principal: "user1",
      sessionId: "s", executionId: "pending-exec", support: [11], messageIds: ["pending-msg"] });
    complete();
    expect((await reaction)?.support).toEqual([11]);
  });

  it("does not retain undelivered IDs from incomplete recall JSON", () => {
    recordDeliveredRecall("truncated-exec", '{"hits":[{"memoryId":22}],"truncated":');
    expect(takeToolEvidence("truncated-exec").size).toBe(0);
    recordDeliveredRecall("complete-exec", '{"hits":[{"memoryId":22}]}');
    expect([...takeToolEvidence("complete-exec").keys()]).toEqual([22]);
  });

  it("does not report explicit false or structured authorization errors as applied", async () => {
    const runtime = { recordFeedback: async (input: { memoryId: number }) => {
      if (input.memoryId === 1) return { ok: false };
      throw Object.assign(new Error("Denied"), { code: "unauthorized" });
    } };
    expect(await recordFeedbackBatch(runtime, "u", "cite", [
      { memoryId: 1, operationKey: "false" }, { memoryId: 2, operationKey: "denied" },
    ])).toEqual({ applied: [], rejected: [2], unknown: [1] });
  });

  it("retains unknown outcomes across concurrent reactions and separate chunk records", async () => {
    const common = { platform: "telegram", channelId: "unknown-chat", principal: "u", sessionId: "s", executionId: "unknown-exec", support: [1] };
    publishAnswerRecord({ ...common, messageIds: ["a"] });
    publishAnswerRecord({ ...common, messageIds: ["b"] });
    let attempts = 0;
    const runtime = { recordFeedback: async () => { attempts++; throw new Error("lost response"); } };
    const first = lookupAnswerRecord("telegram", "unknown-chat", "a")!;
    const second = lookupAnswerRecord("telegram", "unknown-chat", "b")!;
    const outcomes = await Promise.all([recordReactionFeedback(runtime, first, "cite"), recordReactionFeedback(runtime, second, "cite")]);
    expect(outcomes).toEqual([{ applied: [], rejected: [], unknown: [1] }, { applied: [], rejected: [], unknown: [1] }]);
    expect(attempts).toBe(1);
  });
});
