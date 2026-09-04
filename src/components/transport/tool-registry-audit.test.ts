import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutable root-scope predicate for the #1771 audit-tag test below.
const rootScopeMock = vi.hoisted(() => ({ value: false }));

vi.mock("../guardrails.js", () => ({
  checkCommand: () => null,
  classifyCommand: () => "allow",
  isRootScopeAllow: () => rootScopeMock.value,
}));

const home = mkdtempSync(join(tmpdir(), "abtars-audit-1716-"));
process.env["ABTARS_HOME"] = home;
process.env["BASH_TOOL_TIMEOUT_SEC"] = "1";

let executeToolCall: typeof import("./tool-registry.js").executeToolCall;
let auditPath: string;

beforeAll(async () => {
  const mod = await import("./tool-registry.js");
  executeToolCall = mod.executeToolCall;
  auditPath = join(home, "logs", "audit.jsonl");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function readRows(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("#1716 audit call_id pairing through executeToolCall", () => {
  it("writes one start and one ok completion sharing a call_id", async () => {
    await executeToolCall("execute_bash", { command: "echo audit-pair-check" }, { userId: "tester" });
    const rows = readRows().filter((r) => r["args"] !== undefined || r["call_id"] !== undefined);
    const pair = rows.slice(-2);
    expect(pair).toHaveLength(2);
    expect(pair[0]!["tool"]).toBe("execute_bash");
    expect(String(pair[0]!["call_id"])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(pair[1]!["call_id"]).toBe(pair[0]!["call_id"]);
    expect(pair[0]!["status"]).toBeUndefined();
    expect(pair[1]!["status"]).toBe("ok");
    expect(pair[1]!["chars"]).toBeGreaterThan(0);
  });

  it("classifies a timed-out bash call as status timeout, never ok", async () => {
    const start = Date.now();
    const result = await executeToolCall("execute_bash", { command: "sleep 30" }, { userId: "tester" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
    expect(JSON.parse(result)["timed_out"]).toBe(true);
    const rows = readRows();
    const completion = rows[rows.length - 1]!;
    expect(completion["status"]).toBe("timeout");
    expect(typeof completion["call_id"]).toBe("string");
  }, 20_000);

  it("records non-zero exits as ok with exit_code", async () => {
    await executeToolCall("execute_bash", { command: "exit 7" }, { userId: "tester" });
    const completion = readRows()[readRows().length - 1]!;
    expect(completion["status"]).toBe("ok");
    expect(completion["exit_code"]).toBe(7);
  });

  it("never records an ok row for an unknown tool (no start, no completion)", async () => {
    const before = readRows().length;
    await executeToolCall("definitely_not_a_tool_1716", {}, { userId: "tester" });
    expect(readRows().length).toBe(before);
  });

  it("tags root-scope executions with policy root-scope-allow (#1771)", async () => {
    rootScopeMock.value = true;
    try {
      await executeToolCall("execute_bash", { command: "echo root-scope-tag-check" }, { userId: "tester" });
      const start = readRows().filter((r) => r["tool"] === "execute_bash").at(-2)!;
      expect(start["policy"]).toBe("root-scope-allow");
    } finally {
      rootScopeMock.value = false;
    }
    await executeToolCall("execute_bash", { command: "echo no-tag-check" }, { userId: "tester" });
    const plain = readRows().filter((r) => r["tool"] === "execute_bash").at(-2)!;
    expect(plain["policy"]).toBeUndefined();
  });
});

describe("#1716 classifyBashCompletion mapping table", async () => {
  const { classifyBashCompletion } = await import("./tool-registry.js");

  it("maps thrown errors to error status", () => {
    expect(classifyBashCompletion(undefined, true, new Error("boom"))).toEqual({
      status: "error",
      error: "boom",
    });
  });

  it("maps timed_out results to timeout", () => {
    expect(classifyBashCompletion('{"timed_out":true,"exit_code":null}', false, undefined)?.status).toBe("timeout");
  });

  it("maps cleanup_incomplete results to cleanup_incomplete_timeout", () => {
    expect(
      classifyBashCompletion('{"timed_out":true,"cleanup_incomplete":true,"exit_code":null}', false, undefined)?.status,
    ).toBe("cleanup_incomplete_timeout");
  });

  it("maps spawn errors to error status", () => {
    expect(classifyBashCompletion('{"process_error_code":"ENOENT","exit_code":null}', false, undefined)).toMatchObject({
      status: "error",
      process_error_code: "ENOENT",
    });
  });

  it("maps structured execution errors to error status", () => {
    expect(classifyBashCompletion('{"error":"execution_failed","exit_code":null}', false, undefined)).toMatchObject({
      status: "error",
      error: "execution_failed",
    });
  });

  it("maps aborted results to abort", () => {
    expect(classifyBashCompletion('{"aborted":true,"exit_code":null}', false, undefined)?.status).toBe("abort");
  });

  it("keeps ordinary results ok and surfaces exit_code", () => {
    const cls = classifyBashCompletion('{"exit_code":3}', false, undefined);
    expect(cls.status).toBe("ok");
    expect(cls.exit_code).toBe(3);
  });

  it("flags malformed payloads instead of misclassifying", () => {
    const cls = classifyBashCompletion("not-json{{{", false, undefined);
    expect(cls.status).toBe("ok");
    expect(cls.parse_warning).toBe(true);
  });

  it("maps non-bash failures through the generic boundary", () => {
    const cls = classifyBashCompletion(undefined, false, undefined);
    expect(cls.status).toBe("ok");
  });
});
