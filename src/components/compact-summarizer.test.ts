/**
 * compact-summarizer.test.ts — #1406 provider-neutral one-shot compaction
 * summarizer: prompt framing, single bounded call, fallback identity,
 * cancellation, empty/inflation rejection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCompactionPrompt, createCompactionSummarizer } from "./compact-summarizer.js";

describe("buildCompactionPrompt #1406", () => {
  it("frames prior checkpoint, custom instructions, and the serialized source", () => {
    const prompt = buildCompactionPrompt({
      serializedTurns: "1\tuser\thello",
      priorCheckpoint: "old summary",
      maxOutputTokens: 2000,
      customInstructions: "focus on decisions",
    });
    expect(prompt).toContain("old summary");
    expect(prompt).toContain("focus on decisions");
    expect(prompt).toContain("1\tuser\thello");
    expect(prompt).toContain("2000 tokens");
  });

  it("omits prior checkpoint and instructions when absent", () => {
    const prompt = buildCompactionPrompt({
      serializedTurns: "x",
      priorCheckpoint: "",
      maxOutputTokens: 1000,
    });
    expect(prompt).not.toContain("Prior checkpoint");
    expect(prompt).not.toContain("Additional focus");
  });
});

describe("createCompactionSummarizer #1406", () => {
  const mockDispatch = vi.fn();

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue("the checkpoint summary text");
  });

  function makeSpin(): any {
    return { dispatchBackground: mockDispatch };
  }

  it("makes exactly one ephemeral tool-free call and returns text + identity", async () => {
    const summarizer = createCompactionSummarizer(makeSpin());
    const result = await summarizer.summarize({
      serializedTurns: "a".repeat(200),
      priorCheckpoint: "",
      maxOutputTokens: 1000,
    });
    expect(result.text).toBe("the checkpoint summary text");
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]![0]).toMatchObject({ type: "S" });
    expect(mockDispatch.mock.calls[0]![0].prompt).toContain("the checkpoint summary text".length > 0 ? "condense" : "condense");
    expect(result.provider).toBeDefined();
  });

  it("throws before the call when the signal is already aborted", async () => {
    const summarizer = createCompactionSummarizer(makeSpin());
    const controller = new AbortController();
    controller.abort();
    await expect(summarizer.summarize({
      serializedTurns: "x", priorCheckpoint: "", maxOutputTokens: 100, signal: controller.signal,
    })).rejects.toThrow("aborted before start");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("rejects on abort during the call", async () => {
    let rejectPromise: (e: Error) => void = () => {};
    mockDispatch.mockImplementation(() => new Promise((_r, reject) => { rejectPromise = reject; }));
    const summarizer = createCompactionSummarizer(makeSpin());
    const controller = new AbortController();
    const pending = summarizer.summarize({
      serializedTurns: "x", priorCheckpoint: "", maxOutputTokens: 100, signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("rejects an empty provider result", async () => {
    mockDispatch.mockResolvedValue("   ");
    const summarizer = createCompactionSummarizer(makeSpin());
    await expect(summarizer.summarize({
      serializedTurns: "x".repeat(100), priorCheckpoint: "", maxOutputTokens: 100,
    })).rejects.toThrow("empty");
  });

  it("rejects a summary that does not reduce the source (inflation)", async () => {
    mockDispatch.mockResolvedValue("z".repeat(50_000));
    const summarizer = createCompactionSummarizer(makeSpin());
    await expect(summarizer.summarize({
      serializedTurns: "y".repeat(100), priorCheckpoint: "", maxOutputTokens: 100,
    })).rejects.toThrow("does not reduce");
  });
});
