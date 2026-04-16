import { describe, it, expect } from "vitest";
import { extractSummary } from "./compaction.js";

describe("extractSummary", () => {
  it("extracts content from summary tags", () => {
    const input = "<analysis>thinking...</analysis>\n<summary>\n1. User asked for X\n2. We decided Y\n3. Technical context about Z and more details here\n</summary>";
    const result = extractSummary(input);
    expect(result).toContain("User asked for X");
    expect(result).not.toContain("thinking");
  });

  it("returns null when no summary tags", () => {
    expect(extractSummary("Just some random text without tags")).toBeNull();
  });

  it("returns null when summary too short", () => {
    expect(extractSummary("<summary>Too short</summary>")).toBeNull();
  });

  it("strips analysis tags", () => {
    const input = "<analysis>internal reasoning</analysis><summary>" + "A".repeat(60) + "</summary>";
    const result = extractSummary(input);
    expect(result).not.toContain("internal reasoning");
    expect(result).toBe("A".repeat(60));
  });

  it("returns null for empty response", () => {
    expect(extractSummary("")).toBeNull();
  });
});
