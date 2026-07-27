import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaskPackage, createExecutionScope } from "./task-package.js";

describe("loadTaskPackage", () => {
  it("fails when task file does not exist", () => {
    const result = loadTaskPackage("/nonexistent/path/task.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });

  describe("associated-file selection (real filesystem)", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "task-pkg-"));
      writeFileSync(
        join(dir, "task.md"),
        "# Task\nDo the thing\n## Definition of Done\n- /tmp/report.md\n",
      );
    });
    afterEach(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    it("includes admissible regular files and excludes backup/temp/dotfile/tilda siblings (#1502 Task 1/10)", () => {
      writeFileSync(join(dir, "data.csv"), "keep-me");
      writeFileSync(join(dir, "old.bak"), "BAK-CANARY");
      writeFileSync(join(dir, "old.backup"), "BACKUP-CANARY");
      writeFileSync(join(dir, "scratch.tmp"), "TMP-CANARY");
      writeFileSync(join(dir, "task.md~"), "TILDE-CANARY");
      writeFileSync(join(dir, ".secret"), "DOT-CANARY");

      const result = loadTaskPackage(join(dir, "task.md"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prompt).toContain("keep-me");
      expect(result.prompt).not.toContain("BAK-CANARY");
      expect(result.prompt).not.toContain("BACKUP-CANARY");
      expect(result.prompt).not.toContain("TMP-CANARY");
      expect(result.prompt).not.toContain("TILDE-CANARY");
      expect(result.prompt).not.toContain("DOT-CANARY");
      expect(result.contextFiles.map(c => c.name)).toEqual(["data.csv"]);
    });

    it("excludes subdirectories — regular files only (regression: previously crashed with EISDIR)", () => {
      writeFileSync(join(dir, "data.csv"), "keep-me");
      mkdirSync(join(dir, "subdir"));
      writeFileSync(join(dir, "subdir", "nested.md"), "NESTED-CANARY");

      const result = loadTaskPackage(join(dir, "task.md"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prompt).toContain("keep-me");
      expect(result.prompt).not.toContain("NESTED-CANARY");
    });

    it("returns a visible definition failure instead of throwing when a context file is unreadable (#1502)", () => {
      writeFileSync(join(dir, "locked.txt"), "x");
      try { chmodSync(join(dir, "locked.txt"), 0o000); } catch { /* platform-dependent */ }

      // Must NOT throw; on read error it returns { ok: false }. (When run as
      // root the read may succeed — both outcomes are acceptable; a throw is not.)
      const result = loadTaskPackage(join(dir, "task.md"));
      expect(typeof result).toBe("object");
      if (!result.ok) expect(typeof result.error).toBe("string");
    });
  });
});

describe("createExecutionScope", () => {
  it("returns a scoped workspace path", () => {
    const scope = createExecutionScope("test-task");
    expect(scope.cwd).toContain("test-task");
    expect(scope.env.WORKSPACE).toContain("test-task");
  });

  it("returns a frozen env object", () => {
    const scope = createExecutionScope("test");
    expect(Object.isFrozen(scope.env)).toBe(true);
  });
});
