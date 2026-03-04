import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RecallFallbackPipeline } from "./recall-fallback-pipeline.js";
import type { MessageRecord } from "../types/index.js";

// Minimal mocks for dependencies not used by extractContextKeywords
const mockManager = { search: async () => [] } as any;
const mockDetector = {
  analyze: () => ({
    hasRecallIntent: false,
    temporalRange: null,
    strippedQuery: "",
    hasTopicKeywords: false,
  }),
} as any;
const config = {
  enabled: true,
  timeoutMs: 500,
  contextMessages: 5,
  minTokenLength: 3,
  vectorEnabled: false,
};
const pipeline = new RecallFallbackPipeline(mockManager, mockDetector, config);

// Feature: memory-recall-fallback, Property 3: Context Keyword Extraction Produces Tokens from Working Memory
describe("RecallFallbackPipeline — Property 3: Context Keyword Extraction Produces Tokens from Working Memory", () => {
  /**
   * Arbitrary that generates a word of at least 3 alphanumeric characters.
   * This ensures the token survives the minLength filter after punctuation stripping.
   */
  const wordArb = fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
    minLength: 3,
    maxLength: 12,
  });

  /**
   * Arbitrary that generates content strings containing at least one word >= 3 chars.
   * We build content from a mix of generated words joined by spaces.
   */
  const contentArb = fc
    .array(wordArb, { minLength: 1, maxLength: 8 })
    .map((words) => words.join(" "));

  const messageRecordArb = fc.record({
    role: fc.constantFrom("user" as const, "assistant" as const, "compaction" as const),
    content: contentArb,
    timestamp: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
    chatId: fc.integer({ min: 1, max: 100 }),
    sessionId: fc.string({ minLength: 5, maxLength: 20 }),
  });

  it("every returned token appears as a case-insensitive substring in at least one input message's content", () => {
    /**
     * Validates: Requirements 1.2
     *
     * For any non-empty array of working memory MessageRecords,
     * extractContextKeywords should return an array of strings where
     * every returned token appears as a substring (case-insensitive)
     * in at least one of the input messages' content fields.
     */
    fc.assert(
      fc.property(
        fc.array(messageRecordArb, { minLength: 1, maxLength: 10 }),
        (messages) => {
          const tokens = pipeline.extractContextKeywords(messages, messages.length);

          for (const token of tokens) {
            const found = messages.some((msg) =>
              msg.content.toLowerCase().includes(token.toLowerCase()),
            );
            expect(found).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 4: Relaxed Query Drops Short Tokens and Preserves Long Ones
describe("RecallFallbackPipeline — Property 4: Relaxed Query Drops Short Tokens and Preserves Long Ones", () => {
  /**
   * Arbitrary that generates purely alphanumeric tokens (no spaces, no "OR")
   * with lengths between 1 and 10 characters.
   */
  const alphanumTokenArb = fc
    .stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
      minLength: 1,
      maxLength: 10,
    })
    .filter((t) => t !== "OR" && t !== "or" && t !== "Or" && t !== "oR");

  it("output contains all tokens >= minTokenLength and none shorter", () => {
    /**
     * Validates: Requirements 1.3
     *
     * For any query string containing at least one token of length >= minTokenLength,
     * buildRelaxedQuery should return a non-empty string that contains all tokens
     * of length >= minTokenLength from the original query and contains none of the
     * tokens shorter than minTokenLength.
     */
    const minTokenLength = 3;

    fc.assert(
      fc.property(
        fc
          .array(alphanumTokenArb, { minLength: 1, maxLength: 15 })
          .filter((tokens) => tokens.some((t) => t.length >= minTokenLength)),
        (tokens) => {
          const query = tokens.join(" ");
          const result = pipeline.buildRelaxedQuery(query, minTokenLength);

          // Result should be non-empty since we guarantee at least one long token
          expect(result.length).toBeGreaterThan(0);

          // Parse result tokens by splitting on " OR "
          const resultTokens = result.split(" OR ");

          const longTokens = tokens.filter((t) => t.length >= minTokenLength);
          const shortTokens = tokens.filter((t) => t.length < minTokenLength);

          // Every long token from the original must appear in the result
          for (const lt of longTokens) {
            expect(resultTokens).toContain(lt);
          }

          // No short token from the original should appear in the result
          for (const st of shortTokens) {
            expect(resultTokens).not.toContain(st);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 1: Cascade Progression on Empty Results
describe("RecallFallbackPipeline — Property 1: Cascade Progression on Empty Results", () => {
  /**
   * Arbitrary that generates non-empty query strings with at least one word-like token.
   * We use alphanumeric characters to ensure the pipeline has meaningful content to search.
   */
  const queryArb = fc
    .array(
      fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
        minLength: 3,
        maxLength: 12,
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((words) => words.join(" "));

  it("pipeline executes beyond primary stage when all stages return empty", async () => {
    /**
     * Validates: Requirements 1.1
     *
     * For any user message and memory index state where the initial FTS5 search
     * returns zero results, the RecallFallbackPipeline should execute at least
     * two search stages (context-augmented and/or relaxed) before returning an
     * empty result set — meaning the result stage is never "primary".
     */

    // Mock manager that always returns empty results (simulates empty index)
    const emptyManager = { search: async () => [] } as any;

    // Mock detector that returns hasRecallIntent: false so Stage 1 is attempted,
    // but with hasTopicKeywords: true and strippedQuery set to the query so the
    // pipeline has content to cascade through subsequent stages.
    const cascadeDetector = {
      analyze: (query: string) => ({
        hasRecallIntent: false,
        temporalRange: null,
        strippedQuery: query,
        hasTopicKeywords: true,
      }),
    } as any;

    const cascadePipeline = new RecallFallbackPipeline(emptyManager, cascadeDetector, {
      enabled: true,
      timeoutMs: 500,
      contextMessages: 5,
      minTokenLength: 3,
      vectorEnabled: false,
    });

    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const result = await cascadePipeline.execute(query, 1, [], 3);

        // When all stages return empty, the pipeline should have cascaded
        // through all stages and returned stage "none" — never "primary"
        expect(result.stage).not.toBe("primary");
        expect(result.results).toHaveLength(0);
        expect(result.stage).toBe("none");
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 2: Early Termination on First Hit
describe("RecallFallbackPipeline — Property 2: Early Termination on First Hit", () => {
  const stageNames = ["primary", "context", "relaxed", "vector"];

  const dummyResult = {
    record: {
      role: "user" as const,
      content: "test",
      timestamp: Date.now(),
      chatId: 1,
      sessionId: "s1",
    },
    score: 1.0,
  };

  it("stops at stage N and calls search exactly N times", async () => {
    /**
     * Validates: Requirements 1.5
     *
     * For any pipeline execution where stage N returns a non-empty result set,
     * no subsequent stages (N+1, N+2, ...) should execute, and the returned
     * `stage` field should identify stage N.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (hitStage) => {
          let callCount = 0;

          const mockSearchManager = {
            search: async () => {
              callCount++;
              if (callCount === hitStage) {
                return [dummyResult];
              }
              return [];
            },
          } as any;

          const mockDet = {
            analyze: (query: string) => ({
              hasRecallIntent: false,
              temporalRange: null,
              strippedQuery: query,
              hasTopicKeywords: true,
            }),
          } as any;

          const pipelineConfig = {
            enabled: true,
            timeoutMs: 5000,
            contextMessages: 5,
            minTokenLength: 3,
            vectorEnabled: hitStage === 4, // enable vector only when testing stage 4
          };

          const testPipeline = new RecallFallbackPipeline(
            mockSearchManager,
            mockDet,
            pipelineConfig,
          );

          // Provide working memory with long tokens so context-augmented stage has content
          const workingMemory: MessageRecord[] = [
            {
              role: "user",
              content: "alpha beta gamma delta",
              timestamp: Date.now(),
              chatId: 1,
              sessionId: "s1",
            },
          ];

          const result = await testPipeline.execute("testquery", 1, workingMemory, 3);

          // The returned stage should match the expected stage name for call N
          expect(result.stage).toBe(stageNames[hitStage - 1]);

          // Search should have been called exactly N times (no later stages)
          expect(callCount).toBe(hitStage);

          // Results should be non-empty
          expect(result.results.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 6: Recall Intent Skips Primary Stage
describe("RecallFallbackPipeline — Property 6: Recall Intent Skips Primary Stage", () => {
  /**
   * Arbitrary that generates non-empty query strings with alphanumeric tokens.
   */
  const queryArb = fc
    .array(
      fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
        minLength: 3,
        maxLength: 12,
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((words) => words.join(" "));

  it("pipeline never returns stage 'primary' when recall intent is detected", async () => {
    /**
     * Validates: Requirements 2.3
     *
     * For any user message where IntentDetector.analyze returns hasRecallIntent: true,
     * the RecallFallbackPipeline should never return stage: "primary" — it should
     * start at the context-augmented stage or later.
     */

    const dummyResult = {
      record: {
        role: "user" as const,
        content: "recalled memory",
        timestamp: Date.now(),
        chatId: 1,
        sessionId: "s1",
      },
      score: 1.0,
    };

    // Mock MemoryManager that always returns results on every call,
    // so the pipeline stops at the first stage it attempts.
    const alwaysHitManager = {
      search: async () => [dummyResult],
    } as any;

    // Mock IntentDetector that always signals recall intent with topic keywords
    // and a non-empty strippedQuery so the pipeline has content to search.
    const recallIntentDetector = {
      analyze: (query: string) => ({
        hasRecallIntent: true,
        temporalRange: null,
        strippedQuery: query,
        hasTopicKeywords: true,
      }),
    } as any;

    const recallPipeline = new RecallFallbackPipeline(
      alwaysHitManager,
      recallIntentDetector,
      {
        enabled: true,
        timeoutMs: 5000,
        contextMessages: 5,
        minTokenLength: 3,
        vectorEnabled: false,
      },
    );

    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const result = await recallPipeline.execute(query, 1, [], 3);

        // When recall intent is detected, Stage 1 (primary) is skipped.
        // The pipeline should start at Stage 2 (context) or later.
        expect(result.stage).not.toBe("primary");
        expect(result.results.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 8: Temporal Range Threaded into Search Options
describe("RecallFallbackPipeline — Property 8: Temporal Range Threaded into Search Options", () => {
  it("all search calls include matching startTime/endTime from the parsed temporal range", async () => {
    /**
     * Validates: Requirements 3.3, 3.4
     *
     * For any RecallAnalysis with a non-null temporalRange, all search calls
     * made by the RecallFallbackPipeline during that execution should include
     * startTime and endTime in their SearchOptions matching the parsed temporal range.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000000000000, max: 2000000000000 }),
        fc.integer({ min: 1000000000000, max: 2000000000000 }),
        async (ts1, ts2) => {
          const startTime = Math.min(ts1, ts2);
          const endTime = Math.max(ts1, ts2);

          // Record all search call arguments
          const searchCalls: Array<{ query: string; opts: any }> = [];

          const recordingManager = {
            search: async (query: string, opts: any) => {
              searchCalls.push({ query, opts });
              return []; // always empty so pipeline cascades through all stages
            },
          } as any;

          // Mock IntentDetector that returns a RecallAnalysis with the generated temporal range
          const temporalDetector = {
            analyze: (msg: string) => ({
              hasRecallIntent: false,
              temporalRange: { startTime, endTime },
              strippedQuery: msg,
              hasTopicKeywords: true,
            }),
          } as any;

          const temporalPipeline = new RecallFallbackPipeline(
            recordingManager,
            temporalDetector,
            {
              enabled: true,
              timeoutMs: 5000,
              contextMessages: 5,
              minTokenLength: 3,
              vectorEnabled: false,
            },
          );

          searchCalls.length = 0;
          await temporalPipeline.execute("some topic query", 1, [], 3);

          // At least one search call should have been made
          expect(searchCalls.length).toBeGreaterThan(0);

          // Every search call must include the correct startTime and endTime
          for (const call of searchCalls) {
            expect(call.opts.startTime).toBe(startTime);
            expect(call.opts.endTime).toBe(endTime);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 9: Temporal-Only Browsing Returns Time-Ordered Results
describe("RecallFallbackPipeline — Property 9: Temporal-Only Browsing Returns Time-Ordered Results", () => {
  it("returned results have timestamps within [startTime, endTime] and are ordered by timestamp descending", async () => {
    /**
     * Validates: Requirements 3.5
     *
     * For any user message that produces a RecallAnalysis with a non-null
     * temporalRange and hasTopicKeywords: false, all returned results should
     * have timestamps within the [startTime, endTime] range and should be
     * ordered by timestamp descending.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000000000000, max: 1500000000000 }),
        fc.integer({ min: 1500000000001, max: 2000000000000 }),
        async (startTime, endTime) => {
          // Generate mock results with timestamps within the temporal range
          const withinRangeTimestamps = [
            startTime + Math.floor((endTime - startTime) * 0.8),
            startTime + Math.floor((endTime - startTime) * 0.5),
            startTime + Math.floor((endTime - startTime) * 0.2),
          ];

          const mockResults = withinRangeTimestamps.map((ts, i) => ({
            record: {
              role: "user" as const,
              content: `memory ${i}`,
              timestamp: ts,
              chatId: 1,
              sessionId: "s1",
            },
            score: 1.0,
          }));

          // Return results sorted descending by timestamp (as the pipeline expects from the store)
          const sortedResults = [...mockResults].sort(
            (a, b) => b.record.timestamp - a.record.timestamp,
          );

          const temporalOnlyManager = {
            search: async () => sortedResults,
          } as any;

          // Mock IntentDetector: hasRecallIntent true, hasTopicKeywords false, with temporal range
          const temporalOnlyDetector = {
            analyze: () => ({
              hasRecallIntent: true,
              temporalRange: { startTime, endTime },
              strippedQuery: "",
              hasTopicKeywords: false,
            }),
          } as any;

          const temporalOnlyPipeline = new RecallFallbackPipeline(
            temporalOnlyManager,
            temporalOnlyDetector,
            {
              enabled: true,
              timeoutMs: 5000,
              contextMessages: 5,
              minTokenLength: 3,
              vectorEnabled: false,
            },
          );

          const result = await temporalOnlyPipeline.execute("check last week", 1, [], 3);

          // All returned results should have timestamps within the range
          for (const sr of result.results) {
            expect(sr.record.timestamp).toBeGreaterThanOrEqual(startTime);
            expect(sr.record.timestamp).toBeLessThanOrEqual(endTime);
          }

          // Results should be ordered by timestamp descending
          for (let i = 1; i < result.results.length; i++) {
            expect(result.results[i - 1].record.timestamp).toBeGreaterThanOrEqual(
              result.results[i].record.timestamp,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 14: Disabled Fallback Equals Single-Shot
describe("RecallFallbackPipeline — Property 14: Disabled Fallback Equals Single-Shot", () => {
  /**
   * Arbitrary that generates non-empty query strings.
   */
  const queryArb = fc
    .array(
      fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
        minLength: 3,
        maxLength: 12,
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((words) => words.join(" "));

  it("returns stage 'primary' or 'none' with isFallback: false when fallback is disabled", async () => {
    /**
     * Validates: Requirements 5.3
     *
     * For any user message, when MEMORY_RECALL_FALLBACK_ENABLED is false,
     * the pipeline should return a PipelineResult with stage equal to
     * "primary" or "none" and isFallback: false — no fallback stages should execute.
     */
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        fc.boolean(), // whether the mock search returns results or not
        async (query, hasResults) => {
          const dummyResult = {
            record: {
              role: "user" as const,
              content: "test memory",
              timestamp: Date.now(),
              chatId: 1,
              sessionId: "s1",
            },
            score: 1.0,
          };

          let searchCallCount = 0;
          const disabledManager = {
            search: async () => {
              searchCallCount++;
              return hasResults ? [dummyResult] : [];
            },
          } as any;

          const noIntentDetector = {
            analyze: (msg: string) => ({
              hasRecallIntent: false,
              temporalRange: null,
              strippedQuery: msg,
              hasTopicKeywords: true,
            }),
          } as any;

          const disabledPipeline = new RecallFallbackPipeline(
            disabledManager,
            noIntentDetector,
            {
              enabled: false, // fallback disabled
              timeoutMs: 500,
              contextMessages: 5,
              minTokenLength: 3,
              vectorEnabled: false,
            },
          );

          searchCallCount = 0;
          const result = await disabledPipeline.execute(query, 1, [], 3);

          // Stage must be "primary" or "none"
          expect(["primary", "none"]).toContain(result.stage);

          // isFallback must always be false
          expect(result.isFallback).toBe(false);

          // Only one search call should have been made (single-shot)
          expect(searchCallCount).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 15: Timeout Enforcement
describe("RecallFallbackPipeline — Property 15: Timeout Enforcement", () => {
  it("wall-clock time does not exceed timeoutMs + one stage duration + margin", async () => {
    /**
     * Validates: Requirements 1.6
     *
     * For any pipeline execution, the total wall-clock time from execute()
     * call to return should not exceed timeoutMs plus one stage duration
     * (since the budget check happens between stages, not mid-stage).
     */
    const stageDelayMs = 30;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 50, max: 300 }),
        async (timeoutMs) => {
          const slowManager = {
            search: async () => {
              await new Promise((resolve) => setTimeout(resolve, stageDelayMs));
              return [];
            },
          } as any;

          const basicDetector = {
            analyze: (msg: string) => ({
              hasRecallIntent: false,
              temporalRange: null,
              strippedQuery: msg,
              hasTopicKeywords: true,
            }),
          } as any;

          const timeoutPipeline = new RecallFallbackPipeline(
            slowManager,
            basicDetector,
            {
              enabled: true,
              timeoutMs,
              contextMessages: 5,
              minTokenLength: 3,
              vectorEnabled: true,
            },
          );

          const workingMemory: MessageRecord[] = [
            {
              role: "user",
              content: "alpha beta gamma delta",
              timestamp: Date.now(),
              chatId: 1,
              sessionId: "s1",
            },
          ];

          const start = Date.now();
          await timeoutPipeline.execute("test query words", 1, workingMemory, 3);
          const elapsed = Date.now() - start;

          // Budget check is between stages, so one stage may complete after timeout.
          // Allow timeoutMs + one stage duration + 50ms measurement overhead.
          expect(elapsed).toBeLessThanOrEqual(timeoutMs + stageDelayMs + 50);
        },
      ),
      { numRuns: 50 },
    );
  });
});
