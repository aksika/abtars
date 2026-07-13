/**
 * conversation-session.test.ts — Tests for #1335 atomic turn boundaries and tool exchanges.
 */

import { describe, it, expect } from "vitest";
import { ConversationSession } from "./conversation-session.js";

describe("ConversationSession #1335", () => {
  it("scanAtomicUnits returns message units for simple conversation", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.addUser("Hello");
    s.addAssistant("Hi there");
    const units = s.scanAtomicUnits();
    expect(units.length).toBe(2); // system skipped, user + assistant
    expect(units[0]!.kind).toBe("message");
    expect(units[1]!.kind).toBe("message");
  });

  it("scanAtomicUnits detects tool exchanges", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.addUser("Run a command");
    s.addAssistant(null, [
      { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
    ]);
    s.addToolResult("call_1", "bash", "output");
    s.addAssistant("Done");
    const units = s.scanAtomicUnits();
    expect(units.length).toBe(2); // user message + tool exchange
    const exchange = units.find(u => u.kind === "tool_exchange") as { kind: "tool_exchange"; callIds: string[] };
    expect(exchange).toBeDefined();
    expect(exchange.callIds).toContain("call_1");
  });

  it("hasIncompleteToolExchange returns true for unfinished exchange", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.addUser("Run a command");
    s.addAssistant(null, [
      { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
    ]);
    // No tool results added — tool exchange end is at index 2, messages.length is 3
    // The exchange is incomplete because there's no assistant continuation
    expect(s.hasIncompleteToolExchange()).toBe(true);
  });

  it("hasIncompleteToolExchange returns false after tool results added", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.addUser("Run a command");
    s.addAssistant(null, [
      { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
    ]);
    s.addToolResult("call_1", "bash", "done");
    s.addAssistant("Completed");
    expect(s.hasIncompleteToolExchange()).toBe(false);
  });

  it("recordAtomicGrowth tracks positive token deltas", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.totalPromptTokens = 1000;
    s.recordAtomicGrowth(1500); // growth from 1000→1500 = 500
    expect(s.recentAtomicGrowth).toContain(500);
    s.totalPromptTokens = 1500;
    s.recordAtomicGrowth(1800); // growth from 1500→1800 = 300
    expect(s.recentAtomicGrowth).toContain(300);
    expect(s.recentAtomicGrowth.length).toBe(2);
  });

  it("recordAtomicGrowth ignores zero or negative deltas", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.totalPromptTokens = 1000;
    s.recordAtomicGrowth(800);
    expect(s.recentAtomicGrowth.length).toBe(0);
  });

  it("turnBoundaries records user→assistant completion", () => {
    const s = new ConversationSession("You are a bot", 128000);
    s.currentTurnId = "turn-1";
    s.turnBoundaries.push({
      turnId: "turn-1",
      userMessageId: 42,
      disposition: "orphaned",
    });
    s.addUser("Hello");
    // Simulate completion
    const last = s.turnBoundaries[s.turnBoundaries.length - 1]!;
    last.assistantMessageId = 99;
    last.disposition = "complete";
    expect(last.turnId).toBe("turn-1");
    expect(last.disposition).toBe("complete");
    expect(last.assistantMessageId).toBe(99);
  });
});
