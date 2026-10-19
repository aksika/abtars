import { describe, it, expect } from "vitest";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";

describe("createPiExecutionSafetyController", () => {
  it("begins provider turn with continue", () => {
    const ctrl = createPiExecutionSafetyController();
    const result = ctrl.beginProviderTurn("test-model@https://api.test/v1");
    expect(result.decision).toBe("continue");
  });

  it("stops at the prompt round bound with a prompt_round_limit incident", () => {
    const ctrl = createPiExecutionSafetyController({ maxPromptRounds: 3 });
    const key = "test-model@https://api.test/v1";
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(3);
    const result = ctrl.beginProviderTurn(key);
    expect(result.decision).toBe("stop");
    if (result.decision !== "stop") throw new Error("expected stop");
    expect(result.reason).toContain("Prompt round limit");
    expect(ctrl.lastTerminalIncident?.type).toBe("prompt_round_limit");
    expect(ctrl.terminalSafetyFailure).toBe(true);
  });

  it("tracks the active candidate key for incident attribution only", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    expect(ctrl.activeCandidateKey).toBe("model-a@https://a.test/v1");
    ctrl.beginProviderTurn("model-b@https://b.test/v1");
    expect(ctrl.activeCandidateKey).toBe("model-b@https://b.test/v1");
    expect(ctrl.promptRoundsUsed).toBe(2);
  });

  it("detects exact repeat in beforeTool and terminates without recovery", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("k1");
    expect(ctrl.beforeTool("read_file", { path: "/tmp/a" }).decision).toBe("execute");
    expect(ctrl.beforeTool("read_file", { path: "/tmp/a" }).decision).toBe("execute");
    const result = ctrl.beforeTool("read_file", { path: "/tmp/a" });
    expect(result.decision).toBe("error");
    expect(ctrl.lastTerminalIncident?.type).toBe("exact_repeat");
    expect(ctrl.terminalSafetyFailure).toBe(true);
  });

  it("detects repeated failure in afterTool and terminates without recovery", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("bash", { command: "ls -la" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" })).decision).toBe("execute");
    ctrl.beforeTool("bash", { command: "pwd" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" })).decision).toBe("execute");
    ctrl.beforeTool("bash", { command: "whoami" });
    const result = ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" }));
    expect(result.decision).toBe("error");
    expect(ctrl.lastTerminalIncident?.type).toBe("repeated_failure");
    expect(ctrl.terminalSafetyFailure).toBe(true);
  });

  it("a second incident after termination stays terminal", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" }); // exact_repeat, terminal
    // The batch is cancelled: further tools skip, no corrective turn exists.
    expect(ctrl.beforeTool("other", {}).decision).toBe("skip");
    expect(ctrl.incident?.type).toBe("exact_repeat");
  });

  it("skips remaining tools after batch cancellation", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read_file", { path: "/tmp/a" });
    ctrl.beforeTool("read_file", { path: "/tmp/a" });
    ctrl.beforeTool("read_file", { path: "/tmp/a" }); // 3rd call triggers repeat
    expect(ctrl.beforeTool("other", {}).decision).toBe("skip");
  });

  it("resets failure count on success", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("bash", { command: "ls -la" });
    ctrl.afterTool("bash", JSON.stringify({ error: "fail" }));
    ctrl.beforeTool("bash", { command: "pwd" });
    ctrl.afterTool("bash", JSON.stringify({ success: true }));
    ctrl.beforeTool("bash", { command: "whoami" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "fail" })).decision).toBe("execute");
  });

  it("requestPause makes beginProviderTurn pause", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.requestPause();
    expect(ctrl.beginProviderTurn("k1").decision).toBe("pause");
    expect(ctrl.paused).toBe(true);
  });

  it("requestStop makes beginProviderTurn return stop", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.requestStop("user cancelled");
    const result = ctrl.beginProviderTurn("k1");
    expect(result.decision).toBe("stop");
  });

  it("scrubs classified store literals", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.recordClassifiedStoreLiteral("secret123");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      { role: "user", content: "my password is secret123", timestamp: 0 },
    ]);
    const first = scrubbed[0];
    expect(first && "content" in first ? first.content : undefined).toBe("my password is [REDACTED]");
  });

  it("does not scrub short literals", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.recordClassifiedStoreLiteral("ab");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      { role: "user", content: "ab is short", timestamp: 0 },
    ]);
    const second = scrubbed[0];
    expect(second && "content" in second ? second.content : undefined).toBe("ab is short");
  });

  it("scrubs classified literals inside native Pi content blocks", () => {
    const ctrl = createPiExecutionSafetyController();
    ctrl.recordClassifiedStoreLiteral("secret123");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "memory_store",
        content: [{ type: "text", text: "stored secret123" }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    expect((scrubbed[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe("stored [REDACTED]");
  });
});
