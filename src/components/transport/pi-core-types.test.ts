import { describe, it, expect, vi } from "vitest";
import {
  validatePiAgentCoreModule,
  PiCoreContractError,
  createInstructionMessage,
  createCurrentTurnMessage,
  convertInstructionToLlm,
  convertCurrentTurnToLlm,
  PI_AGENT_CORE_CONFIG,
} from "./pi-core-types.js";

describe("validatePiAgentCoreModule", () => {
  function makeValidAgent() {
    return class FakeAgent {
      subscribe() { return () => {}; }
      prompt() { return Promise.resolve(); }
      steer() {}
      followUp() {}
      clearAllQueues() {}
      abort() {}
      waitForIdle() { return Promise.resolve(); }
      get isRunning() { return false; }
    };
  }

  it("accepts a valid module", () => {
    const mod = { Agent: makeValidAgent() };
    expect(() => validatePiAgentCoreModule(mod, "0.80.7")).not.toThrow();
  });

  it("rejects null", () => {
    expect(() => validatePiAgentCoreModule(null, "0.80.7")).toThrow(PiCoreContractError);
  });

  it("rejects missing Agent export", () => {
    expect(() => validatePiAgentCoreModule({}, "0.80.7")).toThrow(PiCoreContractError);
  });

  it("rejects Agent missing prompt method", () => {
    const mod = {
      Agent: class {
        subscribe() {}
        steer() {}
        followUp() {}
        clearAllQueues() {}
        abort() {}
        waitForIdle() {}
        get isRunning() { return false; }
      },
    };
    expect(() => validatePiAgentCoreModule(mod, "0.80.7")).toThrow(PiCoreContractError);
    expect(() => validatePiAgentCoreModule(mod, "0.80.7")).toThrow(/prompt/);
  });

  it("rejects Agent missing waitForIdle", () => {
    const mod = {
      Agent: class {
        subscribe() { return () => {}; }
        prompt() {}
        steer() {}
        followUp() {}
        clearAllQueues() {}
        abort() {}
        get isRunning() { return false; }
      },
    };
    expect(() => validatePiAgentCoreModule(mod, "0.80.7")).toThrow(PiCoreContractError);
    expect(() => validatePiAgentCoreModule(mod, "0.80.7")).toThrow(/waitForIdle/);
  });

  it("sets missingCapability on error", () => {
    try {
      validatePiAgentCoreModule({}, "0.80.7");
    } catch (err) {
      expect(err).toBeInstanceOf(PiCoreContractError);
      expect((err as PiCoreContractError).installationVersion).toBe("0.80.7");
      expect((err as PiCoreContractError).missingCapability).toBe("Agent");
    }
  });
});

describe("createInstructionMessage", () => {
  it("creates a typed instruction message", () => {
    const msg = createInstructionMessage("hello", "lease_1", ["inst_1"], "exec_1", "steer");
    expect(msg.role).toBe("abtars_instruction");
    expect(msg.leaseId).toBe("lease_1");
    expect(msg.instructionIds).toEqual(["inst_1"]);
    expect(msg.executionId).toBe("exec_1");
    expect(msg.kind).toBe("steer");
    expect(msg.content).toBe("hello");
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it("creates followUp message", () => {
    const msg = createInstructionMessage("follow", "lease_2", ["inst_2", "inst_3"], "exec_1", "followUp");
    expect(msg.role).toBe("abtars_instruction");
    expect(msg.kind).toBe("followUp");
    expect(msg.instructionIds).toHaveLength(2);
  });
});

describe("convertInstructionToLlm", () => {
  it("passes non-instruction messages through unchanged", () => {
    const msg = { role: "user", content: "hello" };
    expect(convertInstructionToLlm(msg)).toBe(msg);
  });

  it("converts instruction to user message without metadata", () => {
    const inst = createInstructionMessage("hello", "lease_1", ["inst_1"], "exec_1", "steer");
    const converted = convertInstructionToLlm(inst);
    expect(converted.role).toBe("user");
    expect(converted.content).toContain("hello");
    expect(converted.content).not.toContain("lease_1");
    expect(converted.content).not.toContain("abtars_instruction");
  });
});

describe("createCurrentTurnMessage", () => {
  it("creates a current-turn marker with execution identity", () => {
    const msg = createCurrentTurnMessage("Hello!", "exec_1", "session_1", 42);
    expect(msg.role).toBe("abtars_current_turn");
    expect(msg.executionId).toBe("exec_1");
    expect(msg.sessionId).toBe("session_1");
    expect(msg.durableMessageId).toBe(42);
    expect(msg.content).toBe("Hello!");
  });

  it("creates marker without durable message ID", () => {
    const msg = createCurrentTurnMessage("Hi", "exec_1", "session_1");
    expect(msg.durableMessageId).toBeUndefined();
  });
});

describe("convertCurrentTurnToLlm", () => {
  it("passes non-current-turn messages unchanged", () => {
    const msg = { role: "user", content: "hello" };
    expect(convertCurrentTurnToLlm(msg)).toBe(msg);
  });

  it("converts current-turn to user message preserving content", () => {
    const turn = createCurrentTurnMessage("Hello!", "exec_1", "session_1");
    const converted = convertCurrentTurnToLlm(turn);
    expect(converted.role).toBe("user");
    expect(converted.content).toBe("Hello!");
    expect(converted.content).not.toContain("abtars_current_turn");
    expect(converted.content).not.toContain("exec_1");
  });
});

describe("PI_AGENT_CORE_CONFIG", () => {
  it("configures one-at-a-time steering and sequential tools", () => {
    expect(PI_AGENT_CORE_CONFIG.steeringMode).toBe("one-at-a-time");
    expect(PI_AGENT_CORE_CONFIG.followUpMode).toBe("one-at-a-time");
    expect(PI_AGENT_CORE_CONFIG.toolExecution).toBe("sequential");
  });
});
