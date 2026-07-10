import { describe, it, expect } from "vitest";
import { renderSteeringContinuation } from "./spin.js";
import type { QueuedSessionInstruction } from "./spin-types.js";

function makeInst(text: string, idx: number): QueuedSessionInstruction {
  return { id: `s${idx}`, sessionId: "s1", executionId: "e1", source: "tui", text, createdAt: Date.now() };
}

describe("renderSteeringContinuation", () => {
  it("renders a single instruction", () => {
    const result = renderSteeringContinuation([makeInst("focus on memory", 1)]);
    expect(result).toContain("[USER STEERING");
    expect(result).toContain("1. focus on memory");
    expect(result).toContain("[/USER STEERING]");
    expect(result).toContain("Incorporate this direction");
  });

  it("renders multiple instructions in order", () => {
    const result = renderSteeringContinuation([
      makeInst("first", 1),
      makeInst("second", 2),
      makeInst("third", 3),
    ]);
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
    expect(result).toContain("3. third");
  });

  it("contains the non-deceptive framing", () => {
    const result = renderSteeringContinuation([makeInst("test", 1)]);
    expect(result).toContain("received while you were working");
    expect(result).toContain("Do not restart completed work unnecessarily");
  });
});
