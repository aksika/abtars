import { describe, it, expect, vi } from "vitest";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  validatePiAgentCoreModule,
  PiCoreContractError,
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
    expect(() => validatePiAgentCoreModule(mod, "0.80.8")).not.toThrow();
  });

  it("no longer blocks 0.80.7 (blocklist removed in #1747; minimum is ~0.85.1)", () => {
    expect(() => validatePiAgentCoreModule({ Agent: makeValidAgent() }, "0.80.7")).not.toThrow();
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
    expect(() => validatePiAgentCoreModule(mod, "0.80.8")).toThrow(PiCoreContractError);
    expect(() => validatePiAgentCoreModule(mod, "0.80.8")).toThrow(/prompt/);
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
    expect(() => validatePiAgentCoreModule(mod, "0.80.8")).toThrow(PiCoreContractError);
    expect(() => validatePiAgentCoreModule(mod, "0.80.8")).toThrow(/waitForIdle/);
  });

  it("sets missingCapability on error", () => {
    try {
      validatePiAgentCoreModule({}, "0.80.8");
    } catch (err) {
      expect(err).toBeInstanceOf(PiCoreContractError);
      expect((err as PiCoreContractError).installationVersion).toBe("0.80.8");
      expect((err as PiCoreContractError).missingCapability).toBe("Agent");
    }
  });
});

