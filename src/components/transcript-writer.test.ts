import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { TranscriptWriter } from "./transcript-writer.js";
import type { MessageRecord } from "../types/index.js";
import * as logger from "./logger.js";

vi.mock("./logger.js", () => ({
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

describe("TranscriptWriter", () => {
  let tmpDir: string;
  let writer: TranscriptWriter;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "tw-test-"));
    writer = new TranscriptWriter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- getPath ---

  it("returns correct path structure: {baseDir}/transcripts/{chatId}/{sessionId}.jsonl", () => {
    const path = writer.getPath(42, "abc-123");
    expect(path).toBe(resolve(tmpDir, "transcripts", "42", "abc-123.jsonl"));
  });

  it("converts chatId to string in path", () => {
    const path = writer.getPath(0, "s");
    expect(path).toContain(`${sep}transcripts${sep}0${sep}s.jsonl`);
  });

  // --- append ---

  it("creates directories and writes a single JSON line", () => {
    const record = makeRecord();
    writer.append(record);

    const filePath = writer.getPath(record.chatId, record.sessionId);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it("appends multiple records as separate lines", () => {
    const r1 = makeRecord({ content: "first", timestamp: 1000 });
    const r2 = makeRecord({ content: "second", timestamp: 2000 });

    writer.append(r1);
    writer.append(r2);

    const filePath = writer.getPath(r1.chatId, r1.sessionId);
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(r1);
    expect(JSON.parse(lines[1])).toEqual(r2);
  });

  it("writes assistant role records", () => {
    const record = makeRecord({ role: "assistant", content: "I can help" });
    writer.append(record);

    const filePath = writer.getPath(record.chatId, record.sessionId);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());
    expect(parsed.role).toBe("assistant");
  });

  it("handles records with special characters in content", () => {
    const record = makeRecord({ content: 'line1\nline2\t"quoted"\\backslash' });
    writer.append(record);

    const filePath = writer.getPath(record.chatId, record.sessionId);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());
    expect(parsed.content).toBe(record.content);
  });

  it("logs error and does not throw on write failure", () => {
    // Use /dev/null as base dir — mkdirSync will fail since /dev/null is not a directory
    const badWriter = new TranscriptWriter("/dev/null");
    expect(() => badWriter.append(makeRecord())).not.toThrow();
    expect(logger.logError).toHaveBeenCalledWith(
      "transcript-writer",
      "Failed to append transcript record",
      expect.anything(),
    );
  });

  it("separates transcripts by chatId", () => {
    const r1 = makeRecord({ chatId: 1, sessionId: "s1" });
    const r2 = makeRecord({ chatId: 2, sessionId: "s1" });

    writer.append(r1);
    writer.append(r2);

    const content1 = readFileSync(writer.getPath(1, "s1"), "utf-8").trim();
    const content2 = readFileSync(writer.getPath(2, "s1"), "utf-8").trim();

    expect(JSON.parse(content1).chatId).toBe(1);
    expect(JSON.parse(content2).chatId).toBe(2);
  });

  it("separates transcripts by sessionId", () => {
    const r1 = makeRecord({ chatId: 1, sessionId: "s1" });
    const r2 = makeRecord({ chatId: 1, sessionId: "s2" });

    writer.append(r1);
    writer.append(r2);

    const content1 = readFileSync(writer.getPath(1, "s1"), "utf-8").trim();
    const content2 = readFileSync(writer.getPath(1, "s2"), "utf-8").trim();

    expect(JSON.parse(content1).sessionId).toBe("s1");
    expect(JSON.parse(content2).sessionId).toBe("s2");
  });
});
