/**
 * handlers-memory-1515.test.ts — #1515 /memory questions subcommands.
 *
 * Proves: bare /memory output is preserved, owner-scoped list/dismiss, replay
 * safety, malformed ids, unavailable-memory behavior, and non-master
 * two-user isolation where guessed ids cannot list or mutate the other owner.
 */

import { describe, expect, it, vi } from "vitest";
import { handleMemory } from "./commands/handlers-memory.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    userId: "master",
    reply,
    nlmConfig: { enabled: false },
    memoryRuntime: {
      state: "ready",
      supports: (c: string) => c === "dreamQuestions",
      getStatus: vi.fn().mockResolvedValue({
        totalMessages: 5, extractedMemories: 3, extractedByType: { fact: 3 },
        consolidationFiles: { daily: 1, weekly: 0, quarterly: 0 },
        ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 1024, rejectedByScanner: 0,
      }),
      dreamQuestions: {
        list: vi.fn().mockResolvedValue({ questions: [] }),
        dismiss: vi.fn().mockResolvedValue({ status: "dismissed" }),
      },
    },
    ...overrides,
    reply,
  } as any;
}

describe("#1515 /memory questions", () => {
  it("bare /memory preserves the statistics output", async () => {
    const ctx = makeCtx();
    await handleMemory("/memory", ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0]?.[0] as string;
    expect(text).toContain("Memory Status");
    expect(text).toContain("Raw messages: 5");
    expect(text).toContain("Extracted memories: 3");
  });

  it("/memory questions lists only the caller's active questions with status and age", async () => {
    const ctx = makeCtx({
      memoryRuntime: {
        ...makeCtx().memoryRuntime,
        dreamQuestions: {
          list: vi.fn().mockResolvedValue({
            questions: [{ id: "q-1", status: "pending", createdAt: Date.now() - 2 * 3600_000, question: "Did you prefer the old city?" }],
          }),
          dismiss: vi.fn(),
        },
      },
    });
    await handleMemory("/memory questions", ctx);
    const text = ctx.reply.mock.calls[0]?.[0] as string;
    expect(text).toContain("Memory questions (1):");
    expect(text).toContain("q-1");
    expect(text).toContain("[pending]");
    expect(text).toContain("2h ago");
    expect(text).toContain("Did you prefer the old city?");
  });

  it("an empty active list has a deterministic response", async () => {
    const ctx = makeCtx();
    await handleMemory("/memory questions", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("No pending memory questions.");
  });

  it("/memory questions dismiss <id> dismisses the caller's own question", async () => {
    const dismiss = vi.fn().mockResolvedValue({ status: "dismissed" });
    const ctx = makeCtx({ memoryRuntime: { ...makeCtx().memoryRuntime, dreamQuestions: { list: vi.fn(), dismiss } } });
    await handleMemory("/memory questions dismiss q-1", ctx);
    expect(dismiss).toHaveBeenCalledWith("master", "q-1");
    expect(ctx.reply).toHaveBeenCalledWith("Dismissed question q-1.");
  });

  it("dismiss replay reports the idempotent outcome from the ledger", async () => {
    const dismiss = vi.fn().mockResolvedValue({ status: "dismissed" });
    const ctx = makeCtx({ memoryRuntime: { ...makeCtx().memoryRuntime, dreamQuestions: { list: vi.fn(), dismiss } } });
    await handleMemory("/memory questions dismiss q-1", ctx);
    await handleMemory("/memory questions dismiss q-1", ctx);
    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenLastCalledWith("Dismissed question q-1.");
  });

  it("rejects malformed question ids", async () => {
    const dismiss = vi.fn();
    const ctx = makeCtx({ memoryRuntime: { ...makeCtx().memoryRuntime, dreamQuestions: { list: vi.fn(), dismiss } } });
    await handleMemory("/memory questions dismiss ", ctx);
    expect(dismiss).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("Invalid question id.");
  });

  it("unavailable or unsupported memory returns a deterministic unavailable message", async () => {
    const ctx = makeCtx({ memoryRuntime: { ...makeCtx().memoryRuntime, state: "unavailable" } });
    await handleMemory("/memory questions", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Memory questions are unavailable.");

    const unsupported = makeCtx({ memoryRuntime: { ...makeCtx().memoryRuntime, supports: () => false } });
    await handleMemory("/memory questions dismiss q-1", unsupported);
    expect(unsupported.reply).toHaveBeenCalledWith("Memory questions are unavailable.");
  });

  it("a non-master caller's guessed ids cannot touch another owner's rows", async () => {
    const dismiss = vi.fn().mockResolvedValue({ status: "not_found" });
    const list = vi.fn().mockResolvedValue({ questions: [] });
    const ctx = makeCtx({
      userId: "intruder",
      memoryRuntime: { ...makeCtx().memoryRuntime, dreamQuestions: { list, dismiss } },
    });
    // The runtime is owner-scoped server-side; the handler passes only the
    // caller's own userId and the server refuses owner mismatch as not_found.
    await handleMemory("/memory questions", ctx);
    expect(list).toHaveBeenCalledWith("intruder");
    await handleMemory("/memory questions dismiss q-1", ctx);
    expect(dismiss).toHaveBeenCalledWith("intruder", "q-1");
    expect(ctx.reply).toHaveBeenCalledWith("Question not found.");
  });
});
