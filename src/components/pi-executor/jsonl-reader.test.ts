/**
 * jsonl-reader.test.ts — #1406 strict LF-only JSONL framing tests.
 * Covers fragmented records, several records per chunk, CRLF, malformed and
 * oversized records, recovery after a dropped record, split multibyte UTF-8,
 * and literal U+2028/U+2029 inside JSON strings.
 */
import { describe, it, expect } from "vitest";
import { JsonlReader } from "./jsonl-reader.js";

function collect(maxLineBytes = 1024): { reader: JsonlReader; records: string[]; discarded: Array<{ reason: string; bytes: number }> } {
  const records: string[] = [];
  const discarded: Array<{ reason: string; bytes: number }> = [];
  const reader = new JsonlReader({
    onRecord: r => records.push(r),
    onDiscarded: (reason, bytes) => discarded.push({ reason, bytes }),
  }, maxLineBytes);
  return { reader, records, discarded };
}

describe("JsonlReader #1406", () => {
  it("splits only on LF and delivers several records in one chunk", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n', "utf-8"));
    expect(records).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("retains partial records between chunks", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":', "utf-8"));
    expect(records).toEqual([]);
    reader.push(Buffer.from('1}\n{"b":', "utf-8"));
    expect(records).toEqual(['{"a":1}']);
    reader.push(Buffer.from("2}\n", "utf-8"));
    expect(records).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips exactly one trailing CR for CRLF input", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n', "utf-8"));
    expect(records).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("preserves U+2028 and U+2029 inside JSON strings (readline would split)", () => {
    const { reader, records } = collect();
    const line = '{"content":"line\u2028sep\u2029end"}';
    reader.push(Buffer.from(`${line}\n`, "utf-8"));
    expect(records).toEqual([line]);
  });

  it("reconstructs a multibyte code point split across chunks", () => {
    const { reader, records } = collect();
    const line = '{"content":"h\u00e9llo \ud83d\ude00"}';
    const bytes = Buffer.from(`${line}\n`, "utf-8");
    // Split mid-code-point (emoji = 4 bytes).
    reader.push(bytes.subarray(0, 18));
    reader.push(bytes.subarray(18));
    expect(records).toEqual([line]);
  });

  it("drops an oversized record and resumes with later records", () => {
    const { reader, records, discarded } = collect(20);
    reader.push(Buffer.from('{"small":1}\n{"this record is way too long"}\n{"after":2}\n', "utf-8"));
    expect(records).toEqual(['{"small":1}', '{"after":2}']);
    expect(discarded.some(d => d.reason === "oversized")).toBe(true);
  });

  it("drops an oversized partial record that never terminates, then recovers", () => {
    const { reader, records, discarded } = collect(20);
    reader.push(Buffer.from('{"small":1}\n', "utf-8"));
    // A partial record exceeding the bound, then a newline, then valid records.
    reader.push(Buffer.from("zzzzzzzzzzzzzzzzzzzzzzzz", "utf-8"));
    expect(records).toEqual(['{"small":1}']);
    expect(discarded.some(d => d.reason === "partial_overflow")).toBe(true);
    reader.push(Buffer.from('\n{"ok":1}\n', "utf-8"));
    expect(records).toEqual(['{"small":1}', '{"ok":1}']);
  });

  it("keeps an incomplete record after the last LF pending", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":1}\n{"b":2}', "utf-8"));
    expect(records).toEqual(['{"a":1}']);
    reader.flush();
    expect(records).toEqual(['{"a":1}']);
  });

  it("flush drops the trailing incomplete record", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":1}\npartial', "utf-8"));
    expect(records).toEqual(['{"a":1}']);
    reader.flush();
    expect(records).toEqual(['{"a":1}']);
  });

  it("empty lines between records are not delivered as records", () => {
    const { reader, records } = collect();
    reader.push(Buffer.from('{"a":1}\n\n\n{"b":2}\n', "utf-8"));
    expect(records).toEqual(['{"a":1}', '{"b":2}']);
  });
});
