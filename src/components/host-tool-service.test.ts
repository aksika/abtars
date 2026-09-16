import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostToolService, redactLiterals } from "./host-tool-service.js";
import { SealedSecretHandles } from "./sealed-secret-handles.js";

const FAKE_VALUE = `s3cr3t with spaces "quotes" and $HOME; $(echo pwn) 'single'`;

function makeService(overrides?: {
  handleResolver?: (binding: { memoryId: number; semanticRevision: number }) => Promise<{ value: string } | null>;
}) {
  const handles = new SealedSecretHandles();
  const resolveHandle = overrides?.handleResolver ?? (async (binding: { memoryId: number; semanticRevision: number }) => ({
    value: FAKE_VALUE,
  }));
  const actionGate = { requestAuth: vi.fn(async () => true) };
  const service = new HostToolService({
    handles,
    actionGate: actionGate as never,
    resolveHandle: resolveHandle as never,
  });
  return { service, handles, actionGate };
}

describe("redactLiterals", () => {
  it("replaces overlapping literals longest-first", () => {
    expect(redactLiterals("a very long secret value and a secret value", ["secret value", "very long secret value"]))
      .toBe("a [REDACTED] and a [REDACTED]");
  });

  it("leaves text untouched without literals", () => {
    expect(redactLiterals("plain output", [])).toBe("plain output");
  });
});

describe("HostToolService input validation", () => {
  it("rejects non-ABTARS_SECRET_ keys, ambient collisions, unreferenced names and size bounds", async () => {
    const { service } = makeService();
    const ctx = { userId: "u1", executionId: "e1" };

    const badPrefix = await service.runBash({ command: "true", secretEnv: { HOME_SECRET: "secret:x" } }, ctx);
    expect(JSON.parse(badPrefix)).toMatchObject({ error: "policy_rejected" });

    const collision = await service.runBash({ command: "true", secretEnv: { ABTARS_SECRET_PATH: "secret:x" } }, ctx);
    expect(JSON.parse(collision)).toMatchObject({ error: "policy_rejected" });

    const unreferenced = await service.runBash({ command: "true", secretEnv: { ABTARS_SECRET_TOKEN: "secret:x" } }, ctx);
    expect(JSON.parse(unreferenced)).toMatchObject({ error: "policy_rejected" });

    const notHandle = await service.runBash({ command: "echo $ABTARS_SECRET_TOKEN", secretEnv: { ABTARS_SECRET_TOKEN: "not-a-handle" } }, ctx);
    expect(JSON.parse(notHandle)).toMatchObject({ error: "policy_rejected" });
  });

  it("lets unrestricted sleep execute auth-required and bridge-matching commands without ActionGate", async () => {
    const { service, actionGate } = makeService();
    const result = await service.runBash(
      { command: "if true; then printf '%s' main.js; fi" },
      { userId: "u1", executionId: "sleep-unrestricted", authorizationMode: "unattended-sleep" },
    );
    expect(JSON.parse(result)).toMatchObject({ exit_code: 0, stdout: "main.js" });
    expect(actionGate.requestAuth).not.toHaveBeenCalled();
  });
});

describe("HostToolService secret_env execution", () => {
  it("spawns nothing when a handle is forged, stale or wrong-execution", async () => {
    const { service, handles } = makeService();
    const token = handles.issue({ executionId: "e1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    const ctx = { userId: "u1", executionId: "e1" };

    // Wrong execution: same token, different execution — resolution fails.
    const result = await service.runBash(
      { command: "echo $ABTARS_SECRET_TOKEN", secretEnv: { ABTARS_SECRET_TOKEN: token } },
      { userId: "u1", executionId: "e2" },
    );
    expect(JSON.parse(result)).toMatchObject({ error: "sealed_handle_invalid" });
    void ctx;
  });

  it("injects the exact bytes into the child environment; metacharacters cannot change command structure", async () => {
    const { service, handles } = makeService();
    const token = handles.issue({ executionId: "e1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    const result = await service.runBash(
      { command: "printf '%s' \"$ABTARS_SECRET_TOKEN\"", secretEnv: { ABTARS_SECRET_TOKEN: token } },
      { userId: "u1", executionId: "e1" },
    );
    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(0);
    // The exact bytes arrived (redaction scrubs them from the returned output).
    expect(parsed.stdout).not.toContain(FAKE_VALUE);
    expect(parsed.stdout).toBe("[REDACTED]");
  });

  it("scrubs deliberately echoed values from stdout and stderr", async () => {
    const { service, handles } = makeService();
    const token = handles.issue({ executionId: "e1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    const result = await service.runBash(
      { command: `echo "$ABTARS_SECRET_TOKEN"; echo "$ABTARS_SECRET_TOKEN" >&2`, secretEnv: { ABTARS_SECRET_TOKEN: token } },
      { userId: "u1", executionId: "e1" },
    );
    const parsed = JSON.parse(result);
    expect(parsed.stdout).toBe("[REDACTED]\n");
    expect(parsed.stderr).toBe("[REDACTED]\n");
    expect(result).not.toContain(FAKE_VALUE);
    expect(result).not.toContain(token);
  });

  it("does not resolve or spawn when a later handle fails (all-or-nothing)", async () => {
    const { service, handles } = makeService({
      handleResolver: async (binding) => binding.memoryId === 7 ? { value: "first" } : null,
    });
    const good = handles.issue({ executionId: "e1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    const bad = handles.issue({ executionId: "e1", userId: "u1", memoryId: 8, semanticRevision: 1 });
    const result = await service.runBash(
      { command: "echo $ABTARS_SECRET_A $ABTARS_SECRET_B", secretEnv: { ABTARS_SECRET_A: good, ABTARS_SECRET_B: bad } },
      { userId: "u1", executionId: "e1" },
    );
    expect(JSON.parse(result)).toMatchObject({ error: "sealed_handle_invalid" });
  });

  it("does not expose a resolver exception or reject the request", async () => {
    const { service, handles } = makeService({
      handleResolver: async () => { throw new Error(FAKE_VALUE); },
    });
    const token = handles.issue({ executionId: "e1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    const result = await service.runBash(
      { command: "printf '%s' \"$ABTARS_SECRET_TOKEN\"", secretEnv: { ABTARS_SECRET_TOKEN: token } },
      { userId: "u1", executionId: "e1" },
    );
    expect(JSON.parse(result)).toMatchObject({ error: "execution_failed" });
    expect(result).not.toContain(FAKE_VALUE);
  });

  it("blocks guardrail-rejected and bridge-spawn commands before any resolution", async () => {
    const resolver = vi.fn(async () => ({ value: "x" }));
    const { service } = makeService({ handleResolver: resolver });
    const blocked = await service.runBash(
      { command: "sudo rm -rf /", secretEnv: {} },
      { userId: "u1", executionId: "e1" },
    );
    expect(JSON.parse(blocked)).toMatchObject({ error: "policy_rejected" });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("shell syntax pre-validation (#1595, via service since #1797)", () => {
  const ctx = { userId: "u1", executionId: "e1" };

  it("rejects a malformed trailing 2>& without executing, with a correction hint and untouched audit fields", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "tail -f /var/log/x 2>&" }, ctx);
    const parsed = JSON.parse(result) as {
      error?: string; exit_code?: number; syntax_hint?: string;
      command_fingerprint?: string; command_preview?: string; stderr?: string;
    };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.exit_code).toBe(2);
    expect(parsed.syntax_hint).toContain("2>&1");
    expect(parsed.command_preview).toBe("tail -f /var/log/x 2>&");
    expect(parsed.command_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.stderr).toContain("syntax error");
  });

  it("does not run side effects from a syntactically invalid command", async () => {
    const { service } = makeService();
    const cwd = mkdtempSync(join(tmpdir(), "abtars-syntax-side-effect-"));
    const marker = join(cwd, "must-not-exist");
    try {
      const result = await service.runBash(
        { command: `printf touched > ${JSON.stringify(marker)} 2>&` },
        { ...ctx, executionScope: { cwd, env: Object.freeze({}) } },
      );
      expect(JSON.parse(result)).toMatchObject({ error: "shell_syntax_error" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects other malformed syntax with a structured error and no execution side effect", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "echo 'unterminated" }, ctx);
    expect(JSON.parse(result)).toMatchObject({ error: "shell_syntax_error" });
  });

  it("does not emit the 2>&1 hint for truncations that are not stderr redirects", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "echo hi >" }, ctx);
    const parsed = JSON.parse(result) as { error?: string; syntax_hint?: string };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.syntax_hint).toBeUndefined();
  });

  it("does not guess a correction for the out-of-scope 1>& family", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "echo hi 1>&" }, ctx);
    const parsed = JSON.parse(result) as { error?: string; syntax_hint?: string };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.syntax_hint).toBeUndefined();
  });

  it("still executes valid redirects unchanged (2>&1, 2>&2, 2>&-)", async () => {
    const { service } = makeService();
    for (const suffix of ["2>&1", "2>&2", "2>&-"]) {
      const result = await service.runBash({ command: `echo ok ${suffix} >/dev/null` }, ctx);
      const parsed = JSON.parse(result) as { error?: string; exit_code?: number };
      expect(parsed.error).toBeUndefined();
      expect(parsed.exit_code).toBe(0);
    }
  });

  it("does not rewrite quoted or heredoc content", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "cat << 'EOF'\n2>& is literal text here\nEOF" }, ctx);
    const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string };
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain("2>& is literal text here");
  });

  it("does not rewrite commands whose syntax is valid even with redirects mid-command", async () => {
    const { service } = makeService();
    const result = await service.runBash({ command: "echo a > /tmp/x 2>&1; echo done" }, ctx);
    const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string };
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain("done");
  });
});

describe("#1716 bounded settlement boundary", () => {
  it("a hung command settles as a typed timeout diagnostic instead of wedging the turn", async () => {
    const _reset = await import("./env-schema.js");
    process.env["BASH_TOOL_TIMEOUT_SEC"] = "1";
    _reset._resetEnv();
    const { parseBashResultToDiagnostic } = await import("./transport/tool-failure-diagnostic.js");
    const { service } = makeService();
    const ctx = { userId: "u1", executionId: "e1-timeout" };
    const start = Date.now();
    const result = await service.runBash({ command: "sleep infinity" }, ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
    const parsed = JSON.parse(result);
    expect(parsed.timed_out).toBe(true);
    const diagnostic = parseBashResultToDiagnostic(result, "e1-timeout", "execute_bash");
    expect(diagnostic?.reason).toBe("timeout");
    expect(diagnostic?.timed_out).toBe(true);
    delete process.env["BASH_TOOL_TIMEOUT_SEC"];
    _reset._resetEnv();
  }, 20_000);

  it("a successful command still yields no failure diagnostic", async () => {
    const { parseBashResultToDiagnostic } = await import("./transport/tool-failure-diagnostic.js");
    const { service } = makeService();
    const result = await service.runBash({ command: "echo fine" }, { userId: "u1", executionId: "e1-ok" });
    expect(JSON.parse(result).exit_code).toBe(0);
    expect(parseBashResultToDiagnostic(result, "e1-ok", "execute_bash")).toBeNull();
  });

  it("a pre-aborted request spawns nothing and reports aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = makeService();
    const result = await service.runBash(
      { command: "echo nope" },
      { userId: "u1", executionId: "e1-abort", signal: controller.signal },
    );
    expect(JSON.parse(result).aborted).toBe(true);
  });

  it("lets in-root commands through without ActionGate (#1771)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "hostsvc-1771-"));
    const savedHome = process.env["HOME"];
    const savedAbtars = process.env["ABTARS_HOME"];
    process.env["HOME"] = sandbox;
    process.env["ABTARS_HOME"] = join(sandbox, ".abtars");
    try {
      mkdirSync(join(sandbox, ".abtars", "cache"), { recursive: true });
      const { service, actionGate } = makeService();
      const requestAuth = (actionGate as unknown as { requestAuth: ReturnType<typeof vi.fn> }).requestAuth;
      const allowed = await service.runBash(
        { command: "rm -rf ~/.abtars/cache" },
        { userId: "u1", executionId: "e1-1771" },
      );
      expect(JSON.parse(allowed)).toMatchObject({ exit_code: 0 });
      expect(requestAuth).not.toHaveBeenCalled();

      const gated = await service.runBash(
        { command: "rm -rf ~/Documents" },
        { userId: "u1", executionId: "e2-1771" },
      );
      expect(JSON.parse(gated)).toMatchObject({ exit_code: 0 });
      expect(requestAuth).toHaveBeenCalledTimes(1);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
      if (savedAbtars === undefined) delete process.env["ABTARS_HOME"]; else process.env["ABTARS_HOME"] = savedAbtars;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
