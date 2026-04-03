import { describe, it, expect } from "vitest";
import { extractSummary } from "./compaction.js";

describe("extractSummary", () => {
  it("extracts content from <summary> tags", () => {
    const input = "<analysis>thinking...</analysis>\n<summary>The user wanted X</summary>";
    expect(extractSummary(input)).toBe("The user wanted X");
  });

  it("strips <analysis> block", () => {
    const input = "<analysis>long thought</analysis>\n\n<summary>Result here</summary>";
    expect(extractSummary(input)).toBe("Result here");
  });

  it("returns full text if no tags", () => {
    const input = "Just a plain response without tags";
    expect(extractSummary(input)).toBe("Just a plain response without tags");
  });

  it("handles multiline summary", () => {
    const input = "<summary>\n1. Intent: build X\n2. Files: a.ts\n</summary>";
    expect(extractSummary(input)).toContain("1. Intent: build X");
    expect(extractSummary(input)).toContain("2. Files: a.ts");
  });

  it("strips analysis but keeps text outside tags", () => {
    const input = "<analysis>scratch</analysis>\nSome preamble\n<summary>Real content</summary>";
    expect(extractSummary(input)).toBe("Real content");
  });
});
