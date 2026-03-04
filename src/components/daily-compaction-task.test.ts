import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { loadMemoryConfig, MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import { isEligibleForCompaction, getUncompactedSessions, createDailyCompactionTask, runStartupCatchUp } from "./daily-compaction-task.js";
import { initializeDatabase } from "./memory-db.js";
import { TranscriptParser } from "./transcript-parser.js";
import { MemoryIndex } from "./memory-index.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

/** Wipe all MEMORY_* env vars so each test starts clean. */
function clearMemoryEnv() {
  const keys = Object.keys(process.env).filter((k) => k.startsWith("MEMORY_"));
  for (const k of keys) delete process.env[k];
}

// Feature: auto-daily-compaction, Property 1: Configuration Parsing Resilience
describe("loadMemoryConfig — Property 1: Configuration Parsing Resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearMemoryEnv();
  });

  afterEach(() => {
    clearMemoryEnv();
  });

  it("dayBoundaryHours equals parsed finite number if valid, otherwise defaults to 4", () => {
    /**
     * Validates: Requirements 1.2, 1.3
     *
     * For any string value assigned to MEMORY_DAY_BOUNDARY_HOURS,
     * loadMemoryConfig().dayBoundaryHours should equal the parsed finite number
     * if the string represents a valid finite number, and should equal the
     * default value of 4 otherwise.
     */
    const envValueArb = fc.oneof(
      fc.float({ noNaN: true, noDefaultInfinity: true }).map(String),
      fc.integer({ min: -1000, max: 1000 }).map(String),
      fc.constant("abc"),
      fc.constant("NaN"),
      fc.constant("Infinity"),
      fc.constant("-Infinity"),
      fc.constant(""),
      fc.constant("  "),
      fc.string(),
    );

    fc.assert(
      fc.property(envValueArb, (envValue) => {
        clearMemoryEnv();
        process.env["MEMORY_DAY_BOUNDARY_HOURS"] = envValue;

        const cfg = loadMemoryConfig();
        const parsed = Number(envValue);

        if (envValue === "" || !Number.isFinite(parsed)) {
          expect(cfg.dayBoundaryHours).toBe(MEMORY_CONFIG_DEFAULTS.dayBoundaryHours);
        } else {
          expect(cfg.dayBoundaryHours).toBe(parsed);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: auto-daily-compaction, Property 2: Eligibility Equivalence
describe("isEligibleForCompaction — Property 2: Eligibility Equivalence", () => {
  /**
   * Validates: Requirements 2.1, 2.2, 2.3
   *
   * For any (now, lastMessageTimestamp, dayBoundaryHours) triple,
   * isEligibleForCompaction returns true if and only if:
   * - now falls on a strictly later calendar day than lastMessageTimestamp, AND
   * - now - lastMessageTimestamp >= dayBoundaryHours * 3_600_000
   */

  it("returns true iff now is on a later calendar day AND gap has elapsed", () => {
    // Generate realistic timestamps within a ~10 year window to avoid Date edge cases
    const baseTimestamp = new Date("2020-01-01T00:00:00Z").getTime();
    const tenYearsMs = 10 * 365.25 * 24 * 3_600_000;

    const timestampArb = fc.integer({ min: baseTimestamp, max: baseTimestamp + tenYearsMs });
    const dayBoundaryArb = fc.double({ min: 0.01, max: 48, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(timestampArb, timestampArb, dayBoundaryArb, (lastMessageTimestamp, now, dayBoundaryHours) => {
        const result = isEligibleForCompaction({ lastMessageTimestamp, now, dayBoundaryHours });

        // Compute expected: strictly later calendar day AND gap elapsed
        const lastMsgDate = new Date(lastMessageTimestamp);
        const nowDate = new Date(now);
        const lastDay = new Date(lastMsgDate.getFullYear(), lastMsgDate.getMonth(), lastMsgDate.getDate());
        const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());

        const isLaterDay = today.getTime() > lastDay.getTime();
        const gapMs = dayBoundaryHours * 3_600_000;
        const gapElapsed = now - lastMessageTimestamp >= gapMs;

        const expected = isLaterDay && gapElapsed;

        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});


// Feature: auto-daily-compaction, Property 4: Already-Compacted Sessions Are Skipped
describe("getUncompactedSessions — Property 4: Already-Compacted Sessions Are Skipped", () => {
  /**
   * Validates: Requirements 5.2, 5.3
   *
   * For any set of sessions where some have existing daily-tier compaction records
   * and some do not, getUncompactedSessions returns only sessions that have no
   * prior daily-tier compaction record.
   */

  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dct-prop4-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only sessions without daily-tier compaction records", () => {
    // Arbitrary for a session: { id suffix, isCompacted flag }
    const sessionArb = fc.record({
      idSuffix: fc.stringMatching(/^[a-z0-9]{1,8}$/),
      isCompacted: fc.boolean(),
    });

    // Generate 1–10 sessions with unique IDs
    const sessionsArb = fc
      .array(sessionArb, { minLength: 1, maxLength: 10 })
      .map((sessions) => {
        // Deduplicate by idSuffix
        const seen = new Set<string>();
        return sessions.filter((s) => {
          if (seen.has(s.idSuffix)) return false;
          seen.add(s.idSuffix);
          return true;
        });
      })
      .filter((sessions) => sessions.length > 0);

    const chatIdArb = fc.integer({ min: 1, max: 10000 });
    const timestampArb = fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 });

    fc.assert(
      fc.property(sessionsArb, chatIdArb, timestampArb, (sessions, chatId, baseTimestamp) => {
        // Clean tables between iterations
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM compactions");

        const insertSession = db.prepare(
          "INSERT INTO sessions (telegram_chat_id, acp_session_id, is_active, created_at, last_activity_at) VALUES (?, ?, 1, ?, ?)",
        );
        const insertMessage = db.prepare(
          "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', 'test message', ?)",
        );
        const insertCompaction = db.prepare(
          "INSERT INTO compactions (chat_id, source_session_id, tier, timestamp, summary, file_path) VALUES (?, ?, 'daily', ?, 'summary', '/tmp/fake.md')",
        );

        const expectedUncompacted: string[] = [];

        for (const session of sessions) {
          const sessionId = `sess-${session.idSuffix}`;
          const msgTimestamp = baseTimestamp + sessions.indexOf(session) * 1000;

          insertSession.run(chatId, sessionId, baseTimestamp, msgTimestamp);
          insertMessage.run(chatId, sessionId, msgTimestamp);

          if (session.isCompacted) {
            insertCompaction.run(chatId, sessionId, msgTimestamp + 1000);
          } else {
            expectedUncompacted.push(sessionId);
          }
        }

        const result = getUncompactedSessions(db, chatId);
        const resultIds = result.map((r) => r.sessionId).sort();

        expect(resultIds).toEqual(expectedUncompacted.sort());
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: auto-daily-compaction, Property 5: Error Resilience Across Sessions
describe("createDailyCompactionTask — Property 5: Error Resilience Across Sessions", () => {
  /**
   * Validates: Requirements 4.4, 7.5
   *
   * For any list of sessions where the LLM call throws an error for a subset,
   * the compaction task should still successfully compact all sessions for which
   * the LLM call succeeds.
   */

  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dct-prop5-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compacts all sessions where LLM succeeds, even when LLM throws for others", async () => {

    // Generate 1–6 sessions, each with a boolean indicating whether LLM should throw
    const sessionArb = fc.record({
      idSuffix: fc.stringMatching(/^[a-z0-9]{1,6}$/),
      shouldThrow: fc.boolean(),
    });

    const sessionsArb = fc
      .array(sessionArb, { minLength: 1, maxLength: 6 })
      .map((sessions) => {
        const seen = new Set<string>();
        return sessions.filter((s) => {
          if (seen.has(s.idSuffix)) return false;
          seen.add(s.idSuffix);
          return true;
        });
      })
      .filter((sessions) => sessions.length > 0);

    const chatIdArb = fc.integer({ min: 1, max: 1000 });

    await fc.assert(
      fc.asyncProperty(sessionsArb, chatIdArb, async (sessions, chatId) => {
        // Clean tables between iterations
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM compactions");

        // Use a timestamp from 2 days ago so all sessions are eligible for compaction
        const twoDaysAgoMs = Date.now() - 2 * 24 * 3_600_000;

        const insertSession = db.prepare(
          "INSERT INTO sessions (telegram_chat_id, acp_session_id, is_active, created_at, last_activity_at) VALUES (?, ?, 1, ?, ?)",
        );
        const insertMessage = db.prepare(
          "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', 'test message', ?)",
        );

        // Track which sessions should succeed
        const throwingSessionIds = new Set<string>();
        const successSessionIds = new Set<string>();

        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i];
          const sessionId = `sess-${session.idSuffix}`;
          const msgTimestamp = twoDaysAgoMs + i * 1000;

          insertSession.run(chatId, sessionId, twoDaysAgoMs, msgTimestamp);
          insertMessage.run(chatId, sessionId, msgTimestamp);

          if (session.shouldThrow) {
            throwingSessionIds.add(sessionId);
          } else {
            successSessionIds.add(sessionId);
          }
        }

        // Create transcript files with session ID embedded in content for identification
        const transcriptDir = join(tmpDir, "transcripts", String(chatId));
        mkdirSync(transcriptDir, { recursive: true });
        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i];
          const sessionId = `sess-${session.idSuffix}`;
          const msgTimestamp = twoDaysAgoMs + i * 1000;

          const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
          const record = JSON.stringify({
            role: "user",
            content: `message from [SID:${sessionId}]`,
            timestamp: msgTimestamp,
            chatId,
            sessionId,
          });
          writeFileSync(transcriptPath, record + "\n");
        }

        const config = {
          ...MEMORY_CONFIG_DEFAULTS,
          memoryDir: tmpDir,
          dayBoundaryHours: 1, // 1 hour gap — all sessions from 2 days ago are eligible
        };

        const transcriptParser = new TranscriptParser();
        const memoryIndex = new MemoryIndex(db);

        // LLM call that throws when content contains a throwing session's marker.
        // We use a unique marker format "[SID:xxx]" to avoid substring collisions
        // (e.g., "sess-9" matching inside "sess-9a").
        const getLlmCallFinal = () => {
          return async (_prompt: string, content: string): Promise<string> => {
            for (const sid of throwingSessionIds) {
              if (content.includes(`[SID:${sid}]`)) {
                throw new Error(`Simulated LLM error for ${sid}`);
              }
            }
            return "LLM summary for successful session";
          };
        };

        const acquireLock = (_chatId: number) => {
          return Promise.resolve(() => {});
        };

        const task = createDailyCompactionTask({
          db,
          config,
          transcriptParser,
          memoryIndex,
          getLlmCall: getLlmCallFinal,
          acquireLock,
        });

        await task.execute();

        // Check compaction records: successful sessions should have records, throwing ones should not
        const compactions = db
          .prepare("SELECT source_session_id FROM compactions WHERE chat_id = ? AND tier = 'daily'")
          .all(chatId) as Array<{ source_session_id: string }>;
        const compactedIds = new Set(compactions.map((c) => c.source_session_id));

        // All sessions where LLM succeeded should be compacted
        for (const sid of successSessionIds) {
          expect(compactedIds.has(sid)).toBe(true);
        }

        // All sessions where LLM threw should NOT be compacted
        for (const sid of throwingSessionIds) {
          expect(compactedIds.has(sid)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});


// Feature: auto-daily-compaction, Property 6: Startup Catch-Up Ignores Inactivity Gap
describe("runStartupCatchUp — Property 6: Startup Catch-Up Ignores Inactivity Gap", () => {
  /**
   * Validates: Requirements 6.1, 6.3
   *
   * For any set of sessions whose messages are entirely from previous calendar days,
   * runStartupCatchUp should compact all of them regardless of whether the inactivity
   * gap has elapsed, and should not compact sessions whose messages are from the
   * current calendar day.
   */

  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dct-prop6-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compacts all previous-day sessions regardless of inactivity gap, skips current-day sessions", async () => {
    // Generate sessions: each is either "previous day" or "today"
    const sessionArb = fc.record({
      idSuffix: fc.stringMatching(/^[a-z0-9]{1,6}$/),
      isPreviousDay: fc.boolean(),
    });

    const sessionsArb = fc
      .array(sessionArb, { minLength: 1, maxLength: 6 })
      .map((sessions) => {
        const seen = new Set<string>();
        return sessions.filter((s) => {
          if (seen.has(s.idSuffix)) return false;
          seen.add(s.idSuffix);
          return true;
        });
      })
      .filter((sessions) => sessions.length > 0);

    const chatIdArb = fc.integer({ min: 1, max: 1000 });

    // Generate a large dayBoundaryHours (up to 48h) to prove the gap is truly ignored
    const dayBoundaryArb = fc.double({ min: 0.5, max: 48, noNaN: true, noDefaultInfinity: true });

    await fc.assert(
      fc.asyncProperty(sessionsArb, chatIdArb, dayBoundaryArb, async (sessions, chatId, dayBoundaryHours) => {
        // Clean tables between iterations
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM compactions");

        const now = Date.now();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();

        // Previous-day: message timestamp 1 hour before midnight (could be within inactivity gap)
        const previousDayTs = todayStartMs - 3_600_000;
        // Current-day: message timestamp 1 hour after midnight
        const currentDayTs = todayStartMs + 3_600_000;

        const insertSession = db.prepare(
          "INSERT INTO sessions (telegram_chat_id, acp_session_id, is_active, created_at, last_activity_at) VALUES (?, ?, 1, ?, ?)",
        );
        const insertMessage = db.prepare(
          "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', 'test message', ?)",
        );

        const expectedCompacted = new Set<string>();
        const expectedSkipped = new Set<string>();

        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i];
          const sessionId = `sess-${session.idSuffix}`;
          const msgTimestamp = session.isPreviousDay ? previousDayTs + i * 100 : currentDayTs + i * 100;

          insertSession.run(chatId, sessionId, msgTimestamp, msgTimestamp);
          insertMessage.run(chatId, sessionId, msgTimestamp);

          // Create transcript file
          const transcriptDir = join(tmpDir, "transcripts", String(chatId));
          mkdirSync(transcriptDir, { recursive: true });
          const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
          const record = JSON.stringify({
            role: "user",
            content: `message from session ${sessionId}`,
            timestamp: msgTimestamp,
            chatId,
            sessionId,
          });
          writeFileSync(transcriptPath, record + "\n");

          if (session.isPreviousDay) {
            expectedCompacted.add(sessionId);
          } else {
            expectedSkipped.add(sessionId);
          }
        }

        const config = {
          ...MEMORY_CONFIG_DEFAULTS,
          memoryDir: tmpDir,
          dayBoundaryHours, // large gap — should be irrelevant for startup catch-up
        };

        const transcriptParser = new TranscriptParser();
        const memoryIndex = new MemoryIndex(db);

        const getLlmCall = () => {
          return async (_prompt: string, _content: string): Promise<string> => {
            return "LLM summary for startup catch-up";
          };
        };

        const acquireLock = (_chatId: number) => {
          return Promise.resolve(() => {});
        };

        await runStartupCatchUp({
          db,
          config,
          transcriptParser,
          memoryIndex,
          getLlmCall,
          acquireLock,
        });

        // Check compaction records
        const compactions = db
          .prepare("SELECT source_session_id FROM compactions WHERE chat_id = ? AND tier = 'daily'")
          .all(chatId) as Array<{ source_session_id: string }>;
        const compactedIds = new Set(compactions.map((c) => c.source_session_id));

        // All previous-day sessions should be compacted (regardless of inactivity gap)
        for (const sid of expectedCompacted) {
          expect(compactedIds.has(sid)).toBe(true);
        }

        // All current-day sessions should NOT be compacted
        for (const sid of expectedSkipped) {
          expect(compactedIds.has(sid)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
