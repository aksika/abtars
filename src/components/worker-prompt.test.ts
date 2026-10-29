/**
 * worker-prompt.test.ts — #1638 Task 8: the shared Worker prompt must never
 * contain a model-counted tool-call limit; it frames work by contract and
 * enforced deadline/safety guard instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const templatePath = join(process.cwd(), "templates", "prompts", "worker.md");

describe("Worker prompt (#1638)", () => {
  const prompt = readFileSync(templatePath, "utf-8");

  it("contains no numeric tool-call limit", () => {
    expect(prompt).not.toContain(">20");
    expect(prompt).not.toContain("exceeds expected complexity");
    expect(/\d+\s*tool calls?/.test(prompt)).toBe(false);
  });

  it("frames work by acceptance contract and enforced deadline/safety guard", () => {
    expect(prompt).toContain("acceptance contract is satisfied");
    expect(prompt).toContain("enforced deadline or safety guard stops the attempt");
    expect(prompt).toContain("report the blocker and evidence");
  });
});
