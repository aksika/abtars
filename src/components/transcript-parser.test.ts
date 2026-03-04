import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptParser } from "./transcript-parser.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { MessageRecord } from "../types/index.js";
import * as logger from "./logger.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "Hello world",
    timestamp: Date.now(),
    chatId: 12345,
    sessionId: "sess-001",
    ...overrides,
  };
}

describe("TranscriptParser", () => {
  let tmpDir: string;
  let parser: TranscriptParser;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "tp-test-"));
    parser = new TranscriptParser();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("empty file produces empty array", () => {
    const filePath = join(tmpDir, "empty.jsonl");
    writeFileSync(filePath, "");

    const result = parser.parse(filePath);
    expect(result).toEqual([]);
  });

  it("single record round-trip (write with TranscriptWriter, read with TranscriptParser)", () => {
    const writer = new TranscriptWriter(tmpDir);
    const record = makeRecord();
    writer.append(record);

    const filePath = writer.getPath(record.chatId, record.sessionId);
    const result = parser.parse(filePath);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(record);
  });

  it("file with only malformed lines returns empty array", () => {
    const filePath = join(tmpDir, "malformed.jsonl");
    writeFileSync(filePath, "not json\n{broken\nrandom text\n");

    const result = parser.parse(filePath);
    expect(result).toEqual([]);
    expect(logger.logWarn).toHaveBeenCalledTimes(3);
  });

  it("mixed valid/malformed lines returns only valid records", () => {
    const record1 = makeRecord({ content: "first", timestamp: 1000 });
    const record2 = makeRecord({ content: "second", timestamp: 2000 });
    const filePath = join(tmpDir, "mixed.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify(record1),
        "not valid json",
        JSON.stringify(record2),
        "{broken",
      ].join("\n") + "\n",
    );

    const result = parser.parse(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(record1);
    expect(result[1]).toEqual(record2);
    expect(logger.logWarn).toHaveBeenCalledTimes(2);
  });

  it("parseTail returns last N records", () => {
    const writer = new TranscriptWriter(tmpDir);
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ content: `msg-${i}`, timestamp: 1000 + i }),
    );
    for (const r of records) writer.append(r);

    const filePath = writer.getPath(records[0].chatId, records[0].sessionId);
    const result = parser.parseTail(filePath, 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(records[3]);
    expect(result[1]).toEqual(records[4]);
  });

  it("parseTail with count > total records returns all records", () => {
    const writer = new TranscriptWriter(tmpDir);
    const records = Array.from({ length: 3 }, (_, i) =>
      makeRecord({ content: `msg-${i}`, timestamp: 1000 + i }),
    );
    for (const r of records) writer.append(r);

    const filePath = writer.getPath(records[0].chatId, records[0].sessionId);
    const result = parser.parseTail(filePath, 100);

    expect(result).toHaveLength(3);
    expect(result).toEqual(records);
  });

  it("file not found returns empty array and logs error", () => {
    const result = parser.parse(join(tmpDir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
    expect(logger.logError).toHaveBeenCalledWith(
      "transcript-parser",
      expect.stringContaining("Failed to read transcript file"),
      expect.anything(),
    );
  });
});
