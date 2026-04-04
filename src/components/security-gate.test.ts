import { describe, it, expect } from "vitest";
import { SecurityGate } from "./security-gate.js";

describe("SecurityGate", () => {
  it("throws when constructed with empty user whitelist", () => {
    expect(() => new SecurityGate(new Set())).toThrow("at least one");
  });

  it("authorizes a whitelisted user", () => {
    const gate = new SecurityGate(new Set(["42", "99"]));
    expect(gate.authorize("42")).toBe(true);
  });

  it("rejects a non-whitelisted user", () => {
    const gate = new SecurityGate(new Set(["42"]));
    expect(gate.authorize("999")).toBe(false);
  });

  it("handles single-user whitelist", () => {
    const gate = new SecurityGate(new Set(["1"]));
    expect(gate.authorize("1")).toBe(true);
    expect(gate.authorize("2")).toBe(false);
  });

  it("checks channel when allowedChannelIds provided", () => {
    const gate = new SecurityGate(new Set(["42"]), new Set(["ch1", "ch2"]));
    expect(gate.authorize("42", "ch1")).toBe(true);
    expect(gate.authorize("42", "ch3")).toBe(false);
  });

  it("allows all channels with wildcard", () => {
    const gate = new SecurityGate(new Set(["42"]), new Set(["*"]));
    expect(gate.authorize("42", "any-channel")).toBe(true);
  });

  it("throws when channel whitelist is empty", () => {
    expect(() => new SecurityGate(new Set(["42"]), new Set())).toThrow("at least one");
  });
});
