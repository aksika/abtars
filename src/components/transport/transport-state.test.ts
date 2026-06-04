import { describe, it, expect } from "vitest";
import { TransportStateMachine, TransportStateError } from "./transport-state.js";

describe("TransportStateMachine (#188)", () => {
  it("starts in idle", () => {
    const sm = new TransportStateMachine();
    expect(sm.state).toBe("idle");
  });

  it("happy path: idle → prompting → tool-active → prompting → idle", () => {
    const sm = new TransportStateMachine();
    sm.startPrompt();
    expect(sm.state).toBe("prompting");
    sm.toolStarted();
    expect(sm.state).toBe("tool-active");
    sm.toolCompleted();
    expect(sm.state).toBe("prompting");
    sm.promptCompleted();
    expect(sm.state).toBe("idle");
  });

  it("double startPrompt throws", () => {
    const sm = new TransportStateMachine();
    sm.startPrompt();
    expect(() => sm.startPrompt()).toThrow(TransportStateError);
  });

  it("childExited during prompting → reinitializing", () => {
    const sm = new TransportStateMachine();
    sm.startPrompt();
    sm.childExited();
    expect(sm.state).toBe("reinitializing");
  });

  it("childExited during idle → reinitializing", () => {
    const sm = new TransportStateMachine();
    sm.childExited();
    expect(sm.state).toBe("reinitializing");
  });

  it("childExited when destroyed → no-op", () => {
    const sm = new TransportStateMachine();
    sm.destroy();
    sm.childExited(); // should not throw
    expect(sm.state).toBe("destroyed");
  });

  it("reinitSucceeded → idle", () => {
    const sm = new TransportStateMachine();
    sm.childExited();
    sm.reinitSucceeded();
    expect(sm.state).toBe("idle");
  });

  it("3 reinit failures → stalled", () => {
    const sm = new TransportStateMachine({ maxReinitFailures: 3 });
    sm.childExited();
    sm.reinitFailed();
    sm.reinitFailed();
    sm.reinitFailed();
    expect(sm.state).toBe("stalled");
  });

  it("stalled → recover → idle", () => {
    const sm = new TransportStateMachine({ maxReinitFailures: 1 });
    sm.childExited();
    sm.reinitFailed();
    expect(sm.state).toBe("stalled");
    sm.recover();
    expect(sm.state).toBe("idle");
  });

  it("destroy from any active state", () => {
    const sm = new TransportStateMachine();
    sm.startPrompt();
    sm.toolStarted();
    sm.destroy();
    expect(sm.state).toBe("destroyed");
  });

  it("destroyed is terminal — all transitions ignored", () => {
    const sm = new TransportStateMachine();
    sm.destroy();
    sm.childExited();
    expect(sm.state).toBe("destroyed");
  });

  it("cannot prompt from reinitializing", () => {
    const sm = new TransportStateMachine();
    sm.childExited();
    expect(() => sm.startPrompt()).toThrow(TransportStateError);
  });

  it("cannot prompt from stalled", () => {
    const sm = new TransportStateMachine({ maxReinitFailures: 1 });
    sm.childExited();
    sm.reinitFailed();
    expect(() => sm.startPrompt()).toThrow(TransportStateError);
  });

  it("isPromptable only in idle", () => {
    const sm = new TransportStateMachine();
    expect(sm.isPromptable).toBe(true);
    sm.startPrompt();
    expect(sm.isPromptable).toBe(false);
  });

  it("isActive during prompting and tool-active", () => {
    const sm = new TransportStateMachine();
    expect(sm.isActive).toBe(false);
    sm.startPrompt();
    expect(sm.isActive).toBe(true);
    sm.toolStarted();
    expect(sm.isActive).toBe(true);
  });

  it("isAlive false when destroyed or stalled", () => {
    const sm = new TransportStateMachine({ maxReinitFailures: 1 });
    expect(sm.isAlive).toBe(true);
    sm.childExited();
    sm.reinitFailed();
    expect(sm.isAlive).toBe(false);
  });
});
