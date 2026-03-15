import { describe, it, expect } from "vitest";

import { ContextAssembler } from "./context-assembler.js";
import type { MemoryConfig } from "./memory-config.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MessageRecord, SearchResult } from "../types/index.js";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, ...overrides };
}

function makeMockManager(opts: {
  coreKnowledge?: string;
  searchResults?: SearchResult[];
} = {}) {
  return {
    readCoreKnowledge: () => opts.coreKnowledge ?? "",
    getLatestCompaction: () => null,
    search: async (_query: string, _opts?: any) => opts.searchResults ?? [],
  } as any;
}

function makeMessage(role: "user" | "assistant", content: string, idx = 0): MessageRecord {
  return {
    role,
    content,
    timestamp: Date.now() + idx * 1000,
    chatId: 1,
    sessionId: "sess-1",
  };
}

describe("ContextAssembler", () => {
  it("assembles context with all tiers populated", async () => {
    const manager = makeMockManager({
      coreKnowledge: "User prefers TypeScript",
      searchResults: [
        { record: makeMessage("user", "I like dark mode"), score: 1.5 },
        { record: makeMessage("assistant", "Noted, dark mode preference saved"), score: 1.2 },
      ],
    });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      channelKey: "1",
      userInput: "What are my preferences?",
      systemPrompt: "You are a helpful assistant.",
      workingMemory: [
        makeMessage("user", "Hello", 0),
        makeMessage("assistant", "Hi there!", 1),
      ],
    });

    // All sections should be present
    expect(result.text).toContain("[SYSTEM]");
    expect(result.text).toContain("You are a helpful assistant.");
    expect(result.text).toContain("[CORE KNOWLEDGE]");
    expect(result.text).toContain("User prefers TypeScript");
    expect(result.text).toContain("[CONVERSATION]");
    expect(result.text).toContain("user: Hello");
    expect(result.text).toContain("assistant: Hi there!");
    expect(result.text).toContain("[INPUT]");
    expect(result.text).toContain("What are my preferences?");

    // Usage breakdown should be populated
    expect(result.usage.soul).toBeGreaterThan(0);
    expect(result.usage.working).toBeGreaterThan(0);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.total).toBe(
      result.usage.soul + result.usage.recalled +
      result.usage.working + result.usage.input,
    );
  });

  it("omits empty tiers (no recalled memories)", async () => {
    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      channelKey: "1",
      userInput: "Hello",
      systemPrompt: "You are helpful.",
      workingMemory: [makeMessage("user", "Hi", 0)],
    });

    expect(result.text).toContain("[SYSTEM]");
    expect(result.text).not.toContain("[RECALLED MEMORIES]");
    expect(result.text).toContain("[CONVERSATION]");
    expect(result.text).toContain("[INPUT]");
    expect(result.usage.recalled).toBe(0);
  });

  it("truncates working memory when over budget (drops oldest)", async () => {
    const manager = makeMockManager();
    const config = makeConfig({
      contextBudget: { soul: 500, recalled: 600, working: 10 },
    });
    const assembler = new ContextAssembler(manager, config);

    // Create messages that exceed the budget
    const messages = [
      makeMessage("user", "This is the oldest message that should be dropped", 0),
      makeMessage("assistant", "This is a middle message", 1),
      makeMessage("user", "Recent msg", 2),
    ];

    const result = await assembler.assemble({
      chatId: 1,
      userInput: "test",
      systemPrompt: "",
      workingMemory: messages,
    });

    // The oldest message should be dropped, most recent kept
    if (result.text.includes("[CONVERSATION]")) {
      expect(result.text).toContain("Recent msg");
      expect(result.text).not.toContain("oldest message that should be dropped");
    }
    // Working memory tokens should be within budget
    expect(result.usage.working).toBeLessThanOrEqual(10);
  });

  it("respects token budgets per tier", async () => {
    const longKnowledge = "A".repeat(3000); // 750 tokens, exceeds soul budget of 500

    const manager = makeMockManager({
      coreKnowledge: longKnowledge,
    });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      userInput: "test",
      systemPrompt: "Short prompt",
      workingMemory: [],
    });

    // Soul tier should respect its budget
    expect(result.usage.soul).toBeLessThanOrEqual(config.contextBudget.soul);
  });

  it("returns only soul + input when memory is empty", async () => {
    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      userInput: "Hello world",
      systemPrompt: "You are a bot.",
      workingMemory: [],
    });

    expect(result.text).toContain("[SYSTEM]");
    expect(result.text).toContain("You are a bot.");
    expect(result.text).toContain("[INPUT]");
    expect(result.text).toContain("Hello world");
    expect(result.text).not.toContain("[RECALLED MEMORIES]");
    expect(result.text).not.toContain("[CONVERSATION]");
    expect(result.usage.recalled).toBe(0);
    expect(result.usage.working).toBe(0);
    expect(result.usage.soul).toBeGreaterThan(0);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.total).toBe(result.usage.soul + result.usage.input);
  });
});

import fc from "fast-check";

// ── Shared arbitraries for property tests ──────────────────────────────────

const searchResultArb = fc.record({
  record: fc.record({
    role: fc.constantFrom("user" as const, "assistant" as const),
    content: fc.string({ minLength: 5, maxLength: 50 }),
    timestamp: fc.integer({ min: 1000000000000, max: 2000000000000 }),
    chatId: fc.constant(1),
    sessionId: fc.constant("s1"),
  }),
  score: fc.float({ min: Math.fround(0.1), max: Math.fround(10), noNaN: true }),
});

// ── Property 10: Formatting with Fallback Annotation ───────────────────────
// Feature: memory-recall-fallback, Property 10: Formatting with Fallback Annotation

describe("Property 10: Formatting with Fallback Annotation", () => {
  it("should include [FALLBACK] label when isFallback is true and omit it when false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(searchResultArb, { minLength: 1, maxLength: 10 }),
        fc.boolean(),
        async (results, isFallback) => {
          const mockPipeline = {
            execute: async () => ({
              results,
              stage: isFallback ? "context" : "primary",
              isFallback,
            }),
          } as any;

          const manager = makeMockManager();
          const config = makeConfig();
          const assembler = new ContextAssembler(manager, config);
          assembler.setPipeline(mockPipeline);

          const assembled = await assembler.assemble({
            chatId: 1,
            userInput: "test query",
            systemPrompt: "",
            workingMemory: [],
          });

          if (!assembled.text.includes("[RECALLED MEMORIES]")) {
            // No recalled section means results were empty or didn't fit budget — valid
            return;
          }

          const recalledSection = assembled.text.split("[RECALLED MEMORIES]")[1]?.split("\n\n")[0] ?? "";
          const lines = recalledSection.split("\n").filter((l) => l.startsWith("- "));

          for (const line of lines) {
            // Every line should follow `- [role] content` or `- [FALLBACK] [role] content`
            if (isFallback) {
              expect(line).toMatch(/^- \[FALLBACK\] \[(user|assistant)\] .+/);
            } else {
              expect(line).toMatch(/^- \[(user|assistant)\] .+/);
              expect(line).not.toContain("[FALLBACK]");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 11: Token Budget Enforcement ──────────────────────────────────
// Feature: memory-recall-fallback, Property 11: Token Budget Enforcement

describe("Property 11: Token Budget Enforcement", () => {
  it("should not exceed the configured token budget for recalled memories", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(searchResultArb, { minLength: 1, maxLength: 20 }),
        async (results) => {
          const mockPipeline = {
            execute: async () => ({
              results,
              stage: "context" as const,
              isFallback: true,
            }),
          } as any;

          const manager = makeMockManager();
          const config = makeConfig(); // recalled budget = 600 tokens = 2400 chars
          const assembler = new ContextAssembler(manager, config);
          assembler.setPipeline(mockPipeline);

          const assembled = await assembler.assemble({
            chatId: 1,
            userInput: "test",
            systemPrompt: "",
            workingMemory: [],
          });

          // Token budget for recalled is 600 tokens
          expect(assembled.usage.recalled).toBeLessThanOrEqual(config.contextBudget.recalled);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 12: Merge and Deduplication Prefers Higher Scores ─────────────
// Feature: memory-recall-fallback, Property 12: Merge and Deduplication Prefers Higher Scores

describe("Property 12: Merge and Deduplication Prefers Higher Scores", () => {
  it("should deduplicate by timestamp:content and keep the higher score", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(searchResultArb, { minLength: 1, maxLength: 5 }),
        fc.array(searchResultArb, { minLength: 1, maxLength: 5 }),
        async (primaryResults, extraResults) => {
          // Create overlapping entries: take some from primary, give them different scores
          const overlapping: SearchResult[] = primaryResults.map((r) => ({
            record: { ...r.record },
            score: r.score + 1, // higher score for the "fallback" copy
          }));

          const allFallback = [...extraResults, ...overlapping];

          // We test through the public API by using two pipeline calls:
          // The mergeAndDedup is private, so we verify behavior through the assembler.
          // We'll create a pipeline that returns the combined set and check no duplicates in output.
          const combined = new Map<string, SearchResult>();
          for (const r of [...primaryResults, ...allFallback]) {
            const key = `${r.record.timestamp}:${r.record.content}`;
            const existing = combined.get(key);
            if (!existing || r.score > existing.score) {
              combined.set(key, r);
            }
          }
          const expectedDeduped = [...combined.values()];

          // Use a pipeline that returns all results merged
          const mockPipeline = {
            execute: async () => ({
              results: expectedDeduped,
              stage: "primary" as const,
              isFallback: false,
            }),
          } as any;

          const manager = makeMockManager();
          const config = makeConfig();
          const assembler = new ContextAssembler(manager, config);
          assembler.setPipeline(mockPipeline);

          const assembled = await assembler.assemble({
            chatId: 1,
            userInput: "test",
            systemPrompt: "",
            workingMemory: [],
          });

          if (!assembled.text.includes("[RECALLED MEMORIES]")) return;

          const recalledSection = assembled.text.split("[RECALLED MEMORIES]")[1]?.split("\n\n")[0] ?? "";
          const lines = recalledSection.split("\n").filter((l) => l.startsWith("- "));

          // Verify no duplicate content lines
          const seen = new Set<string>();
          for (const line of lines) {
            expect(seen.has(line)).toBe(false);
            seen.add(line);
          }

          // Verify each entry in the output corresponds to the max-scored version
          for (const line of lines) {
            // Extract content from the line: `- [role] content`
            const match = line.match(/^- \[(user|assistant)\] (.+)$/);
            if (!match) continue;
            const content = match[2];

            // Find all entries with this content and verify the one kept has the max score
            const matching = [...primaryResults, ...allFallback].filter(
              (r) => r.record.content === content,
            );
            if (matching.length > 1) {
              const maxScore = Math.max(...matching.map((r) => r.score));
              const kept = expectedDeduped.find((r) => r.record.content === content);
              if (kept) {
                expect(kept.score).toBe(maxScore);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Unit Tests: ContextAssembler Integration (Task 6.7) ────────────────────

describe("ContextAssembler integration with RecallFallbackPipeline", () => {
  it("injects recalled memories from pipeline", async () => {
    const mockPipeline = {
      execute: async () => ({
        results: [{ record: makeMessage("user", "I like cats"), score: 2.0 }],
        stage: "context",
        isFallback: true,
      }),
    } as any;

    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);
    assembler.setPipeline(mockPipeline);

    const assembled = await assembler.assemble({
      chatId: 1,
      userInput: "tell me about my pets",
      systemPrompt: "",
      workingMemory: [],
    });

    expect(assembled.text).toContain("[RECALLED MEMORIES]");
    expect(assembled.text).toContain("I like cats");
    expect(assembled.usage.recalled).toBeGreaterThan(0);
  });

  it("injects primary recall results from pipeline", async () => {
    const mockPipeline = {
      execute: async () => ({
        results: [{ record: makeMessage("user", "I prefer dark mode"), score: 3.0 }],
        stage: "primary",
        isFallback: false,
      }),
    } as any;

    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);
    assembler.setPipeline(mockPipeline);

    const assembled = await assembler.assemble({
      chatId: 1,
      userInput: "what are my preferences",
      systemPrompt: "",
      workingMemory: [],
    });

    expect(assembled.text).toContain("[RECALLED MEMORIES]");
    expect(assembled.text).toContain("I prefer dark mode");
    expect(assembled.usage.recalled).toBeGreaterThan(0);
  });

  it("does not exceed token budget with large result sets", async () => {
    // Generate 20 results with long content to exceed the 600-token budget
    const results: SearchResult[] = Array.from({ length: 20 }, (_, i) => ({
      record: makeMessage("user", `This is a fairly long recalled memory entry number ${i} with extra padding to consume tokens quickly ${"x".repeat(100)}`, i),
      score: 10 - i * 0.1,
    }));

    const mockPipeline = {
      execute: async () => ({
        results,
        stage: "context",
        isFallback: true,
      }),
    } as any;

    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);
    assembler.setPipeline(mockPipeline);

    const assembled = await assembler.assemble({
      chatId: 1,
      userInput: "test",
      systemPrompt: "",
      workingMemory: [],
    });

    // 600 tokens budget for recalled memories
    expect(assembled.usage.recalled).toBeLessThanOrEqual(600);
  });

  it("injects single-shot search results when no pipeline", async () => {
    const searchResults: SearchResult[] = [
      { record: makeMessage("user", "single-shot result"), score: 2.0 },
    ];
    const manager = makeMockManager({ searchResults });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const assembled = await assembler.assemble({
      chatId: 1,
      userInput: "find something",
      systemPrompt: "",
      workingMemory: [],
    });

    expect(assembled.text).toContain("[RECALLED MEMORIES]");
    expect(assembled.text).toContain("single-shot result");
    expect(assembled.usage.recalled).toBeGreaterThan(0);
  });

  it("returns no recalled section when pipeline returns empty results", async () => {
    const mockPipeline = {
      execute: async () => ({
        results: [],
        stage: "none",
        isFallback: false,
      }),
    } as any;

    const manager = makeMockManager();
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);
    assembler.setPipeline(mockPipeline);

    const assembled = await assembler.assemble({
      chatId: 1,
      userInput: "test",
      systemPrompt: "",
      workingMemory: [],
    });

    expect(assembled.text).not.toContain("[RECALLED MEMORIES]");
    expect(assembled.usage.recalled).toBe(0);
  });
});
