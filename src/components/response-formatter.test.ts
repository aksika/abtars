import { describe, it, expect, beforeEach } from "vitest";
import { ResponseFormatter } from "./response-formatter.js";

describe("ResponseFormatter", () => {
  let formatter: ResponseFormatter;

  beforeEach(() => {
    formatter = new ResponseFormatter();
  });

  describe("collectChunk / flush", () => {
    it("collects and flushes chunks for a session", () => {
      formatter.collectChunk("s1", "Hello ");
      formatter.collectChunk("s1", "world");
      const result = formatter.flush("s1");
      expect(result).toEqual(["Hello world"]);
    });

    it("returns empty array for unknown session", () => {
      expect(formatter.flush("unknown")).toEqual([]);
    });

    it("clears buffer after flush", () => {
      formatter.collectChunk("s1", "data");
      formatter.flush("s1");
      expect(formatter.flush("s1")).toEqual([]);
    });
  });

  describe("chunkText", () => {
    it("returns single chunk for short text", () => {
      expect(formatter.chunkText("short")).toEqual(["short"]);
    });

    it("splits long text at paragraph boundaries", () => {
      const para1 = "a".repeat(3000);
      const para2 = "b".repeat(3000);
      const text = `${para1}\n\n${para2}`;
      const chunks = formatter.chunkText(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(para1);
      expect(chunks[1]).toBe(para2);
    });

    it("all chunks are within 4096 chars", () => {
      const text = "x".repeat(10000);
      const chunks = formatter.chunkText(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
    });
  });

  describe("toTelegramMarkdown", () => {
    it("escapes special characters", () => {
      expect(formatter.toTelegramMarkdown("hello_world")).toBe("hello\\_world");
    });

    it("preserves code blocks", () => {
      const input = "text `code_here` more";
      const result = formatter.toTelegramMarkdown(input);
      expect(result).toContain("`code_here`");
    });

    it("preserves fenced code blocks", () => {
      const input = "text\n```\ncode_block\n```\nmore";
      const result = formatter.toTelegramMarkdown(input);
      expect(result).toContain("```\ncode_block\n```");
    });
  });

  describe("formatToolStatus", () => {
    it("formats start status", () => {
      expect(formatter.formatToolStatus("readFile", "start")).toBe("🔧 readFile...");
    });

    it("formats done status", () => {
      expect(formatter.formatToolStatus("readFile", "done")).toBe("✅ readFile");
    });

    it("formats error status", () => {
      expect(formatter.formatToolStatus("readFile", "error")).toBe("❌ readFile failed");
    });
  });
});
