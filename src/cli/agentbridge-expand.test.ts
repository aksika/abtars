import { describe, it, expect } from "vitest";
import { parseArgs } from "./agentbridge-expand.js";

describe("agentbridge-expand parseArgs", () => {
  it("parses comma-separated IDs", () => {
    const result = parseArgs(["node", "expand", "--ids", "10,20,30"]);
    expect(result.ids).toEqual([10, 20, 30]);
  });

  it("filters out invalid IDs", () => {
    const result = parseArgs(["node", "expand", "--ids", "5,abc,0,12"]);
    expect(result.ids).toEqual([5, 12]);
  });

  it("handles single ID", () => {
    const result = parseArgs(["node", "expand", "--ids", "42"]);
    expect(result.ids).toEqual([42]);
  });
});
