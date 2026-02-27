import { describe, it, expect } from "vitest";

import { ContextAssembler } from "./context-assembler.js";
import type { MemoryConfig } from "./memory-config.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MessageRecord, SearchResult } from "../types/index.js";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, ...overrides };
}

function makeMockManager(opts: {
  scratchpad?: string;
  userCoreFacts?: string;
  searchResults?: SearchResult[];
} = {}) {
  return {
    readScratchpad: (_chatId: number) => opts.scratchpad ?? "",
    readUserCoreFacts: (_chatId: number) => opts.userCoreFacts ?? "",
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
      scratchpad: "Current task: fix bug #42",
      userCoreFacts: "User prefers TypeScript",
      searchResults: [
        { record: makeMessage("user", "I like dark mode"), score: 1.5 },
        { record: makeMessage("assistant", "Noted, dark mode preference saved"), score: 1.2 },
      ],
    });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
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
    expect(result.text).toContain("[USER FACTS]");
    expect(result.text).toContain("User prefers TypeScript");
    expect(result.text).toContain("[SCRATCHPAD]");
    expect(result.text).toContain("Current task: fix bug #42");
    expect(result.text).toContain("[RECALLED MEMORIES]");
    expect(result.text).toContain("I like dark mode");
    expect(result.text).toContain("[CONVERSATION]");
    expect(result.text).toContain("user: Hello");
    expect(result.text).toContain("assistant: Hi there!");
    expect(result.text).toContain("[INPUT]");
    expect(result.text).toContain("What are my preferences?");

    // Usage breakdown should be populated
    expect(result.usage.soul).toBeGreaterThan(0);
    expect(result.usage.scratchpad).toBeGreaterThan(0);
    expect(result.usage.recalled).toBeGreaterThan(0);
    expect(result.usage.working).toBeGreaterThan(0);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.total).toBe(
      result.usage.soul + result.usage.scratchpad + result.usage.recalled +
      result.usage.working + result.usage.input,
    );
  });

  it("omits empty tiers (no scratchpad, no recalled memories)", async () => {
    const manager = makeMockManager({
      scratchpad: "",
      userCoreFacts: "",
      searchResults: [],
    });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      userInput: "Hello",
      systemPrompt: "You are helpful.",
      workingMemory: [makeMessage("user", "Hi", 0)],
    });

    expect(result.text).toContain("[SYSTEM]");
    expect(result.text).not.toContain("[USER FACTS]");
    expect(result.text).not.toContain("[SCRATCHPAD]");
    expect(result.text).not.toContain("[RECALLED MEMORIES]");
    expect(result.text).toContain("[CONVERSATION]");
    expect(result.text).toContain("[INPUT]");
    expect(result.usage.scratchpad).toBe(0);
    expect(result.usage.recalled).toBe(0);
  });

  it("truncates working memory when over budget (drops oldest)", async () => {
    const manager = makeMockManager();
    // Set a very small working memory budget (10 tokens = 40 chars)
    const config = makeConfig({
      contextBudget: { soul: 500, scratchpad: 300, recalled: 600, working: 10 },
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
    // Create content that exceeds each tier's budget
    const longFacts = "A".repeat(3000); // 750 tokens, exceeds soul budget of 500
    const longScratchpad = "B".repeat(2000); // 500 tokens, exceeds scratchpad budget of 300

    const manager = makeMockManager({
      userCoreFacts: longFacts,
      scratchpad: longScratchpad,
      searchResults: [],
    });
    const config = makeConfig();
    const assembler = new ContextAssembler(manager, config);

    const result = await assembler.assemble({
      chatId: 1,
      userInput: "test",
      systemPrompt: "Short prompt",
      workingMemory: [],
    });

    // Each tier should respect its budget
    expect(result.usage.soul).toBeLessThanOrEqual(config.contextBudget.soul);
    expect(result.usage.scratchpad).toBeLessThanOrEqual(config.contextBudget.scratchpad);
  });

  it("returns only soul + input when memory is empty", async () => {
    const manager = makeMockManager({
      scratchpad: "",
      userCoreFacts: "",
      searchResults: [],
    });
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
    expect(result.text).not.toContain("[SCRATCHPAD]");
    expect(result.text).not.toContain("[RECALLED MEMORIES]");
    expect(result.text).not.toContain("[CONVERSATION]");
    expect(result.usage.scratchpad).toBe(0);
    expect(result.usage.recalled).toBe(0);
    expect(result.usage.working).toBe(0);
    expect(result.usage.soul).toBeGreaterThan(0);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.total).toBe(result.usage.soul + result.usage.input);
  });
});
