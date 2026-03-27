import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { MemoryExtractor } from "./memory-extractor.js";

describe("MemoryExtractor", () => {
  let db: Database.Database;
  let llmCall: ReturnType<typeof vi.fn>;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (chat_id INTEGER, role TEXT, content TEXT, timestamp INTEGER);
      CREATE TABLE extracted_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER, content_en TEXT, content_original TEXT,
        memory_type TEXT, emotion_score INTEGER DEFAULT 0,
        source_timestamp INTEGER, source_message_ids TEXT,
        preserve_original INTEGER DEFAULT 0, preserved_keyword TEXT,
        classification INTEGER DEFAULT 0, created_at INTEGER
      );
      CREATE TABLE extraction_watermarks (chat_id INTEGER PRIMARY KEY, last_processed_timestamp INTEGER);
    `);
    llmCall = vi.fn();
    extractor = new MemoryExtractor(db, llmCall);
  });

  afterEach(() => { db.close(); });

  it("returns empty when no messages", async () => {
    const result = await extractor.processTranscripts(1);
    expect(result).toEqual([]);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("calls LLM with transcript and inserts extracted memories", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'I like TypeScript', 1000)`);
    db.exec(`INSERT INTO messages VALUES (1, 'assistant', 'Noted!', 1001)`);

    llmCall.mockResolvedValue(JSON.stringify([{
      content_en: "User likes TypeScript",
      content_original: "User likes TypeScript",
      memory_type: "preference",
      emotion_score: 2,
      preserve_original: false,
      preserved_keyword: null,
    }]));

    const result = await extractor.processTranscripts(1);
    expect(result).toHaveLength(1);
    expect(result[0].content_en).toBe("User likes TypeScript");
    expect(llmCall).toHaveBeenCalledOnce();

    // Verify inserted into DB
    const rows = db.prepare("SELECT * FROM extracted_memories").all();
    expect(rows).toHaveLength(1);
  });

  it("advances watermark after successful extraction", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'hello', 500)`);
    llmCall.mockResolvedValue("[]");

    await extractor.processTranscripts(1);

    // Second call should find no new messages
    const result = await extractor.processTranscripts(1);
    expect(result).toEqual([]);
    expect(llmCall).toHaveBeenCalledOnce(); // only first call
  });

  it("does not advance watermark on LLM failure", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'important fact', 1000)`);
    llmCall.mockRejectedValue(new Error("LLM timeout"));

    const result = await extractor.processTranscripts(1);
    expect(result).toEqual([]);

    // Watermark not advanced — next call retries
    llmCall.mockResolvedValue("[]");
    await extractor.processTranscripts(1);
    expect(llmCall).toHaveBeenCalledTimes(2);
  });

  it("handles malformed LLM response gracefully", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'test', 1000)`);
    llmCall.mockResolvedValue("not valid json at all");

    const result = await extractor.processTranscripts(1);
    expect(result).toEqual([]);
  });

  it("clamps emotion scores to -5..+5", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'test', 1000)`);
    llmCall.mockResolvedValue(JSON.stringify([{
      content_en: "test", content_original: "test",
      memory_type: "fact", emotion_score: 99,
      preserve_original: false, preserved_keyword: null,
    }]));

    const result = await extractor.processTranscripts(1);
    expect(result[0].emotion_score).toBeLessThanOrEqual(5);
  });

  it("processes multiple chats independently", async () => {
    db.exec(`INSERT INTO messages VALUES (1, 'user', 'chat1 msg', 1000)`);
    db.exec(`INSERT INTO messages VALUES (2, 'user', 'chat2 msg', 1000)`);
    llmCall.mockResolvedValue("[]");

    await extractor.processTranscripts(1);
    await extractor.processTranscripts(2);
    expect(llmCall).toHaveBeenCalledTimes(2);
  });
});
