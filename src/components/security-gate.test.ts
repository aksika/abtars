import { describe, it, expect } from "vitest";
import { SecurityGate } from "./security-gate.js";
import type { TelegramMessage } from "../types/index.js";

function makeMessage(userId?: number): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 100, type: "private" },
    date: Date.now(),
    from: userId !== undefined ? { id: userId, is_bot: false, first_name: "Test" } : undefined,
  };
}

describe("SecurityGate", () => {
  it("throws when constructed with empty whitelist", () => {
    expect(() => new SecurityGate(new Set())).toThrow("at least one");
  });

  it("authorizes a whitelisted user", () => {
    const gate = new SecurityGate(new Set([42, 99]));
    expect(gate.authorize(makeMessage(42))).toBe(true);
  });

  it("rejects a non-whitelisted user", () => {
    const gate = new SecurityGate(new Set([42]));
    expect(gate.authorize(makeMessage(999))).toBe(false);
  });

  it("rejects a message with no from field", () => {
    const gate = new SecurityGate(new Set([42]));
    expect(gate.authorize(makeMessage(undefined))).toBe(false);
  });

  it("handles single-user whitelist", () => {
    const gate = new SecurityGate(new Set([1]));
    expect(gate.authorize(makeMessage(1))).toBe(true);
    expect(gate.authorize(makeMessage(2))).toBe(false);
  });
});
