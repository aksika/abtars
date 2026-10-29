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
  isExecutionOverlapError,
  ANSWER_RECORD_TTL_MS,
} from "./answer-evidence.js";

const REF_A = "db:durable:7:u1:aaa";
const REF_B = "db:durable:8:u1:bbb";
const REF_C = "db:durable:9:u1:ccc";

describe("#1928 answer evidence (owner ref keys)", () => {
  it("validates declarations against host-observed evidence only", () => {
    // Forged/stale refs degrade to the eligible subset, never authorize writes.
    expect(validateSupportIds([REF_A, "db:durable:999:u1:zzz", REF_A, "7", ""], new Set([REF_A]))).toEqual([REF_A]);
    expect(validateSupportIds(["db:durable:999:u1:zzz"], new Set([REF_A]))).toEqual([]);
  });

  it("unions declaration and heuristic support over injected and tool evidence", () => {
    // Tool-only answer: declared tool ref validates without any injection.
    expect(resolveAnswerSupport({ declared: [REF_A], heuristic: [], autoInjected: [], toolDelivered: new Set([REF_A]) })).toEqual([REF_A]);
    // Heuristic citation of an injected memory joins the declaration.
    expect(resolveAnswerSupport({ declared: [REF_A], heuristic: [REF_B], autoInjected: [REF_A, REF_B], toolDelivered: new Set() })).toEqual([REF_A, REF_B]);
    // Neither path rescues a ref nobody delivered.
    expect(resolveAnswerSupport({ declared: [REF_C], heuristic: [REF_C], autoInjected: [REF_A], toolDelivered: new Set([REF_B]) })).toEqual([]);
  });

  it("isolates tool evidence per execution and drains once", () => {
    recordToolEvidence("e1", [{ ref: REF_A }, { ref: "" }, {}], 1_000);
    recordToolEvidence("e2", [{ ref: REF_C }], 1_000);
    expect([...takeToolEvidence("e1", 1_001)]).toEqual([REF_A]);
    // Drained: a second take finds nothing (no double attribution).
    expect(takeToolEvidence("e1", 1_002).size).toBe(0);
    expect([...takeToolEvidence("e2", 1_003)]).toEqual([REF_C]);
  });

  it("aliases every delivered chunk to one answer record", () => {
    publishAnswerRecord(
      { platform: "telegram", channelId: "chat1", principal: "user1", sessionId: "s1", executionId: "e1", support: [REF_A, REF_B], messageIds: ["m1", "m2"] },
      1_000,
    );
    expect(lookupAnswerRecord("telegram", "chat1", "m1", 1_001)?.support).toEqual([REF_A, REF_B]);
    expect(lookupAnswerRecord("telegram", "chat1", "m2", 1_001)?.support).toEqual([REF_A, REF_B]);
  });

  it("misses safely: unknown IDs, other chats, and expired records", () => {
    // Unique IDs per test: the stores are process-local and shared.
    publishAnswerRecord(
      { platform: "telegram", channelId: "chatX", principal: "user1", sessionId: "s1", executionId: "e1", support: [REF_A], messageIds: ["mx"] },
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
      sessionId: "s", executionId: "pending-exec", support: [REF_A], messageIds: ["pending-msg"] });
    complete();
    expect((await reaction)?.support).toEqual([REF_A]);
  });

  it("does not retain undelivered refs from incomplete recall JSON", () => {
    recordDeliveredRecall("truncated-exec", '{"hits":[{"ref":"db:durable:22:u1:abc"}],"truncated":');
    expect(takeToolEvidence("truncated-exec").size).toBe(0);
    recordDeliveredRecall("complete-exec", '{"hits":[{"ref":"db:durable:22:u1:abc"}]}');
    expect([...takeToolEvidence("complete-exec")]).toEqual(["db:durable:22:u1:abc"]);
  });

});
