import { describe, it, expect } from "vitest";
import { fmtLogCtx } from "./task-log-ctx.js";

describe("task log safety", () => {
  it("fmtLogCtx produces stable correlation fields", () => {
    const result = fmtLogCtx({ task: "finance-daily", run: "abc123", attempt: 1, card: 42 });
    expect(result).toContain("task=finance-daily");
    expect(result).toContain("run=abc123");
    expect(result).toContain("attempt=1");
    expect(result).toContain("card=42");
  });

  it("fmtLogCtx omits undefined fields", () => {
    const result = fmtLogCtx({ task: "test" });
    expect(result).toBe("task=test");
    expect(result).not.toContain("run=");
    expect(result).not.toContain("attempt=");
  });

  it("fmtLogCtx handles empty ctx", () => {
    expect(fmtLogCtx({})).toBe("");
  });

  it("fmtLogCtx does not include secrets or raw content", () => {
    const malicious = fmtLogCtx({ task: "sensitive-task" });
    expect(malicious).toBe("task=sensitive-task");
    expect(malicious).not.toContain("sk-");
    expect(malicious).not.toContain("secret");
  });
});
