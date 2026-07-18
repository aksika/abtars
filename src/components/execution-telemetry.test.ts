import { describe, it, expect } from "vitest";
import { createExecutionTelemetryScope } from "./execution-telemetry.js";

describe("createExecutionTelemetryScope (#1444)", () => {
  it("creates a scope with the given execution ID", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    expect(scope.executionId).toBe("exec_1");
  });

  it("beginProviderCall returns a handle with unique ID and ordinal", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h1 = scope.beginProviderCall({ provider: "openai", model: "gpt-4", startedAt: Date.now() });
    const h2 = scope.beginProviderCall({ provider: "anthropic", model: "claude-3", startedAt: Date.now() });

    expect(h1.providerCallId).toBeTruthy();
    expect(h2.providerCallId).toBeTruthy();
    expect(h1.providerCallId).not.toBe(h2.providerCallId);
    expect(h2.ordinal).toBe(h1.ordinal + 1);
  });

  it("end records a terminal event idempotently", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h = scope.beginProviderCall({ provider: "openai", startedAt: Date.now() });
    h.end({ result: "success", endedAt: Date.now(), input: 100, output: 50 });
    // Second call should be no-op
    h.end({ result: "failure", endedAt: Date.now() });
    const snap = scope.snapshot();
    expect(snap).toBeTruthy();
    expect(snap!.input).toBe(100);
  });

  it("snapshot aggregates across multiple provider calls", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h1 = scope.beginProviderCall({ provider: "openai", startedAt: Date.now() });
    h1.end({ result: "success", endedAt: Date.now(), input: 100, output: 50 });

    const h2 = scope.beginProviderCall({ provider: "anthropic", startedAt: Date.now() });
    h2.end({ result: "success", endedAt: Date.now(), input: 200, output: 100 });

    const snap = scope.snapshot();
    expect(snap).toBeTruthy();
    expect(snap!.input).toBe(300);
    expect(snap!.output).toBe(150);
  });

  it("snapshot includes cacheRead and cacheWrite", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h = scope.beginProviderCall({ startedAt: Date.now() });
    h.end({ result: "success", endedAt: Date.now(), input: 100, output: 50, cacheRead: 80, cacheWrite: 20 });
    const snap = scope.snapshot();
    expect(snap!.cacheRead).toBe(80);
    expect(snap!.cacheWrite).toBe(20);
  });

  it("snapshot returns undefined when no calls have usage", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h = scope.beginProviderCall({ startedAt: Date.now() });
    h.end({ result: "failure", endedAt: Date.now() });
    expect(scope.snapshot()).toBeUndefined();
  });

  it("snapshot returns undefined when no calls made", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    expect(scope.snapshot()).toBeUndefined();
  });

  it("close prevents new calls from being recorded", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    scope.close();
    const h = scope.beginProviderCall({ startedAt: Date.now() });
    expect(h.ordinal).toBe(-1);
    expect(h.providerCallId).toBe("");
  });

  it("close does not affect prior calls", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h = scope.beginProviderCall({ startedAt: Date.now() });
    h.end({ result: "success", endedAt: Date.now(), input: 50, output: 25 });
    scope.close();
    const snap = scope.snapshot();
    expect(snap).toBeTruthy();
    expect(snap!.input).toBe(50);
  });

  it("handles fallbackFrom in telemetry", () => {
    const scope = createExecutionTelemetryScope("exec_1");
    const h = scope.beginProviderCall({
      provider: "openai", model: "gpt-4",
      fallbackFrom: "gpt-3.5-turbo", startedAt: Date.now(),
    });
    h.end({ result: "success", endedAt: Date.now(), input: 100, output: 50 });
    const snap = scope.snapshot();
    expect(snap!.input).toBe(100);
  });
});
