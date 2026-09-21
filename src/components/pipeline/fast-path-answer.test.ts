/**
 * #1813 — fast-path gate and delivery tests. The gate is pure (matrix over
 * decision + turn shape); delivery uses stub adapter/runtime. Each case pins
 * one eligibility rule so a future relaxation fails loudly.
 */
import { describe, expect, it, vi } from "vitest";
import { fastPathAnswerText, deliverFastPathAnswer } from "./fast-path-answer.js";
import type { RuntimeRecallDecision } from "../memory-runtime.js";

const ANSWER: RuntimeRecallDecision = {
  version: 1,
  outcome: "answer",
  answerText: "Production deploys run via /deploy prod.",
  answerLanguage: "en",
  sourceIds: [3],
  sourceRevisions: { 3: 0 },
  selectedRefs: [3],
  profile: "jev/jev-1.13.0 lookup-v1",
  questionSet: "lookup-v1",
};

const MAIN_TEXT_TURN = { sessionType: "A", skillIsolated: false, hasAttachment: false, voice: false, sessionStart: false, delivery: "simple" };

describe("#1813 — fastPathAnswerText", () => {
  it("renders the extract with visible source refs on an eligible turn, raw text for memory", () => {
    expect(fastPathAnswerText(ANSWER, MAIN_TEXT_TURN)).toEqual({
      display: "Production deploys run via /deploy prod.\n\n— memory #3",
      record: "Production deploys run via /deploy prod.",
    });
  });

  it("stays closed without a decision or without an answer outcome", () => {
    expect(fastPathAnswerText(undefined, MAIN_TEXT_TURN)).toBeNull();
    expect(fastPathAnswerText({ ...ANSWER, outcome: "continue" }, MAIN_TEXT_TURN)).toBeNull();
    expect(fastPathAnswerText({ ...ANSWER, outcome: "already-supplied" }, MAIN_TEXT_TURN)).toBeNull();
  });

  it("stays closed on empty text, missing sources, or wrong turn shape", () => {
    expect(fastPathAnswerText({ ...ANSWER, answerText: "  " }, MAIN_TEXT_TURN)).toBeNull();
    expect(fastPathAnswerText({ ...ANSWER, sourceIds: [] }, MAIN_TEXT_TURN)).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, sessionType: "O" })).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, skillIsolated: true })).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, hasAttachment: true })).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, voice: true })).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, sessionStart: true })).toBeNull();
    expect(fastPathAnswerText(ANSWER, { ...MAIN_TEXT_TURN, delivery: "streaming" })).toBeNull();
  });
});

describe("#1813 — deliverFastPathAnswer", () => {
  function stubAdapter(sent: string[]) {
    return {
      chunkResponse: (text: string) => [text],
      sendMessage: vi.fn(async (_channel: string, text: string) => { sent.push(text); return 1; }),
    };
  }

  it("sends chunks, records the assistant message, and reports recorded", async () => {
    const sent: string[] = [];
    const recordMessage = vi.fn(async () => ({ id: 99 }));
    const onDelivered = vi.fn();
    const res = await deliverFastPathAnswer("answer text", {
      adapter: stubAdapter(sent) as never,
      channelId: "c1",
      recordAssistant: {
        runtime: { recordMessage: recordMessage as never },
        recordText: "answer text",
        platform: "telegram",
        userId: "u1",
        sessionId: "s1",
        guest: false,
      },
      onDelivered,
    });
    expect(res).toEqual({ delivered: true, recorded: true });
    expect(sent).toEqual(["answer text"]);
    expect(recordMessage).toHaveBeenCalledTimes(1);
    expect(recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "answer text" }),
      expect.any(String),
    );
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("skips the memory record for guests but still delivers", async () => {
    const sent: string[] = [];
    const recordMessage = vi.fn(async () => ({ id: 99 }));
    const res = await deliverFastPathAnswer("answer text", {
      adapter: stubAdapter(sent) as never,
      channelId: "c1",
      recordAssistant: {
        runtime: { recordMessage: recordMessage as never },
        recordText: "answer text",
        platform: "telegram",
        userId: "guest-1",
        sessionId: "s1",
        guest: true,
      },
    });
    expect(res).toEqual({ delivered: true, recorded: false });
    expect(sent).toEqual(["answer text"]);
    expect(recordMessage).not.toHaveBeenCalled();
  });

  it("reports undelivered when every chunk is blank", async () => {
    const sent: string[] = [];
    const res = await deliverFastPathAnswer("   ", {
      adapter: stubAdapter(sent) as never,
      channelId: "c1",
    });
    expect(res).toEqual({ delivered: false, recorded: false });
    expect(sent).toEqual([]);
  });
});
