import { describe, it, expect } from "vitest";
import {
  fingerprintCommand,
  previewCommand,
  parseBashResultToDiagnostic,
  parseToolResultToDiagnostic,
  buildUnknownDiagnostic,
  mergeSafetyIncident,
  renderDiagnostic,
  PiCoreToolExecutionError,
} from "./tool-failure-diagnostic.js";

describe("fingerprintCommand", () => {
  it("produces deterministic 16-char hex fingerprint", () => {
    const fp = fingerprintCommand("ls -la /tmp");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintCommand("ls -la /tmp")).toBe(fp);
  });

  it("differs for different commands", () => {
    expect(fingerprintCommand("ls")).not.toBe(fingerprintCommand("pwd"));
  });
});

describe("previewCommand", () => {
  it("redacts secrets from preview", () => {
    const preview = previewCommand("curl -H 'Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaaaa' https://api.example.com");
    expect(preview).not.toContain("sk-aaaaaaaaaaaaaaaaaaaaaa");
    expect(preview).toContain("***REDACTED***");
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("truncates long commands", () => {
    const long = "echo " + "a".repeat(300);
    const preview = previewCommand(long);
    expect(preview.length).toBeLessThanOrEqual(160);
    expect(preview).toMatch(/\.\.\.$/);
  });

  it("normalizes whitespace", () => {
    const preview = previewCommand("echo    hello    world");
    expect(preview).toBe("echo hello world");
  });
});

describe("parseBashResultToDiagnostic", () => {
  const execId = "exec_1";

  it("returns null for successful command (exit 0)", () => {
    const result = JSON.stringify({ exit_code: 0, stdout: "ok", stderr: "", command_fingerprint: "abc", command_preview: "echo ok" });
    expect(parseBashResultToDiagnostic(result, execId, "execute_bash")).toBeNull();
  });

  it("detects non-zero exit", () => {
    const result = JSON.stringify({ exit_code: 1, stderr: "error", command_fingerprint: "abc", command_preview: "false" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d).not.toBeNull();
    expect(d!.reason).toBe("nonzero_exit");
    expect(d!.exit_code).toBe(1);
    expect(d!.execution_id).toBe(execId);
    expect(d!.tool).toBe("execute_bash");
  });

  it("detects spawn error (ENOENT)", () => {
    const result = JSON.stringify({ exit_code: null, process_error_code: "ENOENT", stderr: "not found", command_fingerprint: "abc", command_preview: "nonexistent" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.reason).toBe("spawn_error");
    expect(d!.process_error_code).toBe("ENOENT");
  });

  it("detects timeout", () => {
    const result = JSON.stringify({ exit_code: null, timed_out: true, signal: "SIGTERM", command_fingerprint: "abc", command_preview: "sleep 100" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.reason).toBe("timeout");
    expect(d!.timed_out).toBe(true);
  });

  it("detects external abort", () => {
    const result = JSON.stringify({ exit_code: null, aborted: true, signal: "SIGTERM", command_fingerprint: "abc", command_preview: "sleep 100" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.reason).toBe("aborted");
    expect(d!.aborted).toBe(true);
  });

  it("detects policy rejection (exit 126 with error)", () => {
    const result = JSON.stringify({ exit_code: 126, error: "blocked", stderr: "policy violation", command_fingerprint: "abc", command_preview: "rm -rf /" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.reason).toBe("policy_rejected");
  });

  it("caps and redacts stderr", () => {
    const longStderr = "API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaa " + "x".repeat(600);
    const result = JSON.stringify({ exit_code: 1, stderr: longStderr, command_fingerprint: "abc", command_preview: "cmd" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.stderr_excerpt).not.toContain("sk-aaaaaaaaaaaaaaaaaaaaaa");
    expect(d!.stderr_excerpt!.length).toBeLessThanOrEqual(500);
  });

  it("caps and redacts stdout", () => {
    const longStdout = "secret-data " + "y".repeat(300);
    const result = JSON.stringify({ exit_code: 1, stdout: longStdout, command_fingerprint: "abc", command_preview: "cmd" });
    const d = parseBashResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.stdout_excerpt!.length).toBeLessThanOrEqual(240);
  });

  it("returns null for malformed JSON", () => {
    expect(parseBashResultToDiagnostic("not json", execId, "execute_bash")).toBeNull();
  });
});

describe("parseToolResultToDiagnostic", () => {
  const execId = "exec_1";

  it("falls through to bash parsing for structured results", () => {
    const result = JSON.stringify({ exit_code: 1, stderr: "error", command_fingerprint: "abc", command_preview: "false" });
    const d = parseToolResultToDiagnostic(result, execId, "execute_bash");
    expect(d!.reason).toBe("nonzero_exit");
  });

  it("detects error field in non-bash tool results", () => {
    const d = parseToolResultToDiagnostic(JSON.stringify({ error: "permission denied" }), execId, "memory_recall");
    expect(d).not.toBeNull();
    expect(d!.reason).toBe("unknown");
    expect(d!.stderr_excerpt).toContain("permission denied");
  });

  it("returns null for successful non-bash results", () => {
    expect(parseToolResultToDiagnostic(JSON.stringify({ ok: true }), execId, "memory_store")).toBeNull();
  });

  it("returns null for non-JSON results", () => {
    expect(parseToolResultToDiagnostic("plain text output", execId, "irc_send")).toBeNull();
  });
});

describe("buildUnknownDiagnostic", () => {
  it("builds safe fallback diagnostic from error message", () => {
    const d = buildUnknownDiagnostic("exec_1", "execute_bash", "Something went wrong");
    expect(d.reason).toBe("unknown");
    expect(d.tool).toBe("execute_bash");
    expect(d.stderr_excerpt).toContain("Something went wrong");
  });

  it("truncates long error messages", () => {
    const d = buildUnknownDiagnostic("exec_1", "execute_bash", "x".repeat(1000));
    expect(d.stderr_excerpt!.length).toBeLessThanOrEqual(500);
  });
});

describe("mergeSafetyIncident", () => {
  const base: ReturnType<typeof buildUnknownDiagnostic> = {
    version: 1, execution_id: "e1", tool: "execute_bash", reason: "nonzero_exit",
    timed_out: false, aborted: false, exit_code: 1, command_fingerprint: "abc", command_preview: "cmd",
  };

  it("upgrades reason to repeated_failure", () => {
    const merged = mergeSafetyIncident(base, "repeated_failure");
    expect(merged.reason).toBe("repeated_failure");
    expect(merged.safety_incident).toBe("repeated_failure");
  });

  it("upgrades reason to candidate_exhausted", () => {
    const merged = mergeSafetyIncident(base, "candidate_round_limit", true);
    expect(merged.reason).toBe("candidate_exhausted");
    expect(merged.candidate_exhausted).toBe(true);
  });

  it("preserves original when no incident", () => {
    const merged = mergeSafetyIncident(base);
    expect(merged.reason).toBe("nonzero_exit");
    expect(merged.safety_incident).toBeUndefined();
  });
});

describe("renderDiagnostic", () => {
  it("produces actionable string with all fields", () => {
    const d = {
      version: 1 as const,
      execution_id: "e1",
      tool: "execute_bash",
      reason: "nonzero_exit" as const,
      command_fingerprint: "abc123def456",
      command_preview: "ls /nonexistent",
      exit_code: 1,
      timed_out: false,
      aborted: false,
      stderr_excerpt: "No such file",
      stdout_excerpt: "",
    };
    const rendered = renderDiagnostic(d);
    expect(rendered).toContain("Tool execute_bash failed");
    expect(rendered).toContain("fp:abc123def456");
    expect(rendered).toContain("exit:1");
    expect(rendered).toContain("stderr: No such file");
  });

  it("is bounded to 1200 chars", () => {
    const d = {
      version: 1 as const,
      execution_id: "e1",
      tool: "execute_bash",
      reason: "nonzero_exit" as const,
      command_fingerprint: "abc",
      command_preview: "x".repeat(200),
      exit_code: 1,
      timed_out: false,
      aborted: false,
      stderr_excerpt: "y".repeat(501),
      stdout_excerpt: "z".repeat(241),
    };
    expect(renderDiagnostic(d).length).toBeLessThanOrEqual(1200);
  });
});

describe("PiCoreToolExecutionError", () => {
  it("carries diagnostic and renders message from renderDiagnostic", () => {
    const d = {
      version: 1 as const,
      execution_id: "e1",
      tool: "execute_bash",
      reason: "nonzero_exit" as const,
      timed_out: false,
      aborted: false,
      exit_code: 127,
      command_preview: "nonexistent",
    };
    const err = new PiCoreToolExecutionError(d);
    expect(err.name).toBe("PiCoreToolExecutionError");
    expect(err.message).toContain("Tool execute_bash failed");
    expect(err.diagnostic.exit_code).toBe(127);
  });
});
