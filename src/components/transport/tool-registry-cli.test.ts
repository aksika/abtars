import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// #1797: tool-to-CLI boundary must be bin+argv with no shell. The fixtures
// below are real executables resolved through a test-local PATH; registry
// dispatch and runBashCommand stay real. Under the old shell-string
// implementation the metacharacter payloads expand (marker files appear,
// argv is mangled) and these tests fail for that reason — not via a policy
// rejection.

const FIXTURE_NODE = `#!/usr/bin/env node
const exitCode = parseInt(process.env.FIXTURE_EXIT_CODE ?? "0", 10);
console.log(JSON.stringify({ argv: process.argv.slice(2) }));
if (process.env.FIXTURE_STDERR) console.error(process.env.FIXTURE_STDERR);
process.exit(exitCode);
`;

let fixtureDir: string;
let savedPath: string | undefined;
let savedHome: string | undefined;

function writeExe(name: string, content: string): void {
  writeFileSync(join(fixtureDir, name), content, { mode: 0o755 });
}

beforeEach(() => {
  savedPath = process.env.PATH;
  savedHome = process.env.ABTARS_HOME;
  fixtureDir = mkdtempSync(join(tmpdir(), "abtars-cli-fixture-"));
  writeExe("abtars-task", FIXTURE_NODE);
  writeExe("abtars-todo", FIXTURE_NODE);
  process.env.PATH = `${fixtureDir}${savedPath ? `:${savedPath}` : ""}`;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.ABTARS_HOME;
  else process.env.ABTARS_HOME = savedHome;
  delete process.env.FIXTURE_EXIT_CODE;
  delete process.env.FIXTURE_STDERR;
  rmSync(fixtureDir, { recursive: true, force: true });
  const { setHostToolService } = await import("./tool-registry.js");
  setHostToolService(null);
});

async function callTool(name: string, args: Record<string, unknown>) {
  const { executeToolCall } = await import("./tool-registry.js");
  const raw = await executeToolCall(name, args);
  return JSON.parse(raw) as {
    exit_code?: number; stdout?: string; stderr?: string;
    command_preview?: string; error?: string;
  };
}

function fixtureArgv(wrapper: { stdout?: string }): string[] {
  const echoed = JSON.parse(wrapper.stdout ?? "") as { argv: string[] };
  return echoed.argv;
}

describe("todo/task CLI argv boundary (#1797)", () => {
  it("stores shell metacharacters literally: no expansion, no side-effect marker", async () => {
    const marker = join(fixtureDir, "MARKER");
    const payload = `x $(touch ${marker}) \`echo backtick\` $HOME 'sq' "dq" a;b`;
    const wrapper = await callTool("todo_manage", { action: "add", text: payload });
    expect(wrapper.exit_code).toBe(0);
    // Exact argv proves the payload arrived as one argument; the absent
    // marker proves no shell ran the substitution. Against the old
    // implementation the marker exists and argv is mangled.
    expect(fixtureArgv(wrapper)).toEqual(["add", payload]);
    expect(existsSync(marker)).toBe(false);
    // Diagnostic spelling drops the old shell quotes (R3) — pinned, not incidental.
    expect(wrapper.command_preview).toBe(`abtars-todo add ${payload}`);
  });

  it("passes a hostile task id as one argv element with no command break-out", async () => {
    const wrapper = await callTool("task_manage", { action: "pause", id: "y; whoami" });
    expect(wrapper.exit_code).toBe(0);
    expect(fixtureArgv(wrapper)).toEqual(["pause", "y; whoami"]);
    expect(wrapper.command_preview).toBe("abtars-task pause y; whoami");
  });

  it.each([
    ["todo add", "todo_manage", { action: "add", text: "buy milk" }, "abtars-todo", ["add", "buy milk"], "abtars-todo add buy milk"],
    ["todo done", "todo_manage", { action: "done", id: "3" }, "abtars-todo", ["done", "3"], "abtars-todo done 3"],
    ["todo remove", "todo_manage", { action: "remove", id: "3" }, "abtars-todo", ["remove", "3"], "abtars-todo remove 3"],
    ["todo list default", "todo_manage", {}, "abtars-todo", ["list"], "abtars-todo list"],
    ["task list", "task_manage", { action: "list" }, "abtars-task", ["list"], "abtars-task list"],
    ["task remove", "task_manage", { action: "remove", id: "t1" }, "abtars-task", ["remove", "t1"], "abtars-task remove t1"],
    ["task pause", "task_manage", { action: "pause", id: "t1" }, "abtars-task", ["pause", "t1"], "abtars-task pause t1"],
    ["task resume", "task_manage", { action: "resume", id: "t1" }, "abtars-task", ["resume", "t1"], "abtars-task resume t1"],
    ["task add full options", "task_manage",
      { action: "add", message: "ping me", schedule: "0 9 * * *", type: "reminder", chat_id: "42" },
      "abtars-task",
      ["add", "--message", "ping me", "--schedule", "0 9 * * *", "--type", "reminder", "--chat-id", "42"],
      "abtars-task add --message ping me --schedule 0 9 * * * --type reminder --chat-id 42"],
    ["task add omits absent optionals", "task_manage",
      { action: "add", message: "ping me" },
      "abtars-task",
      ["add", "--message", "ping me"],
      "abtars-task add --message ping me"],
  ])("%s maps to fixed argv with preserved wrapper", async (_label, tool, args, _bin, argv, preview) => {
    const wrapper = await callTool(tool, args as Record<string, unknown>);
    expect(wrapper.exit_code).toBe(0);
    expect(fixtureArgv(wrapper)).toEqual(argv);
    expect(wrapper.command_preview).toBe(preview);
  });

  it("preserves nonzero exit and stderr through the same wrapper", async () => {
    process.env.FIXTURE_EXIT_CODE = "3";
    process.env.FIXTURE_STDERR = "cli says no";
    const wrapper = await callTool("todo_manage", { action: "done", id: "9" });
    expect(wrapper.exit_code).toBe(3);
    expect(wrapper.stderr).toContain("cli says no");
    expect(fixtureArgv(wrapper)).toEqual(["done", "9"]);
  });
});

describe("real todo storage keeps literal text (#1797)", () => {
  it("add stores metacharacters verbatim in the isolated todo.md", async () => {
    // Point the fixture executable at the real CLI entry through tsx; the
    // fixture process inherits this test's ABTARS_HOME, so storage lands in
    // an isolated tree and live data is untouched.
    const homeDir = mkdtempSync(join(tmpdir(), "abtars-todo-home-"));
    process.env.ABTARS_HOME = homeDir;
    try {
      const repoRoot = resolve(HERE, "..", "..", "..");
      writeExe("abtars-todo",
        `#!/bin/sh\nexec "${repoRoot}/node_modules/.bin/tsx" "${repoRoot}/src/cli/abtars-todo.ts" "$@"\n`);
      const payload = "buy milk $(date) `id` $HOME 'sq' \"dq\" a;b";
      const wrapper = await callTool("todo_manage", { action: "add", text: payload });
      expect(wrapper.exit_code).toBe(0);
      const stdout = JSON.parse(wrapper.stdout ?? "") as { ok?: boolean; description?: string };
      expect(stdout.ok).toBe(true);
      expect(stdout.description).toBe(payload);
      const stored = readFileSync(join(homeDir, "workspace", "todo", "todo.md"), "utf-8");
      expect(stored).toContain(`: ${payload}\n`);
      expect(stored).not.toContain("MARKER");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("unwired execute_bash fails closed (#1797 R4)", () => {
  it("returns service_unavailable and spawns nothing, without leaking secret_env", async () => {
    const { setHostToolService } = await import("./tool-registry.js");
    setHostToolService(null);
    const marker = join(fixtureDir, "MUST-NOT-EXIST");
    const raw = await (await import("./tool-registry.js")).executeToolCall("execute_bash", {
      command: `touch ${marker}`,
      secret_env: { ABTARS_SECRET_TOKEN: "secret:opaque-handle" },
    }, { userId: "test", executionId: "e1" });
    expect(JSON.parse(raw)).toEqual({
      error: "service_unavailable",
      stderr: "Host tool service is not initialized",
      exit_code: 126,
    });
    expect(raw).not.toContain("secret:opaque-handle");
    expect(raw).not.toContain("touch");
    expect(existsSync(marker)).toBe(false);
  });
});
