import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, validateArgs, loadBrowsePrompt } from "./abtars-browse.js";

const originalHome = process.env.HOME;
const originalCwd = process.cwd;

describe("abtars-browse", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "browse-test-"));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parseArgs", () => {
    it("parses all flags", () => {
      const args = parseArgs(["node", "browse", "--task", "check X", "--chat-id", "123", "--timeout", "600", "--dry-run"]);
      expect(args.task).toBe("check X");
      expect(args.chatId).toBe("123");
      expect(args.timeout).toBe("600");
      expect(args.dryRun).toBe(true);
    });

    it("defaults dryRun to false", () => {
      const args = parseArgs(["node", "browse", "--task", "test", "--chat-id", "1"]);
      expect(args.dryRun).toBe(false);
    });
  });

  describe("validateArgs", () => {
    it("rejects missing --task", () => {
      const result = validateArgs({ chatId: "123", dryRun: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("--task");
    });

    it("rejects missing --chat-id", () => {
      const result = validateArgs({ task: "test", dryRun: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("--chat-id");
    });

    it("accepts valid args with default timeout", () => {
      const result = validateArgs({ task: "test", chatId: "123", dryRun: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task).toBe("test");
        expect(result.chatId).toBe(123);
        expect(result.timeoutMs).toBe(300000);
      }
    });

    it("parses custom timeout", () => {
      const result = validateArgs({ task: "test", chatId: "123", timeout: "60", dryRun: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.timeoutMs).toBe(60000);
    });
  });

  describe("loadBrowsePrompt", () => {
    it("loads template and replaces variables", () => {
      const promptDir = join(tmpDir, ".abtars", "prompts");
      mkdirSync(promptDir, { recursive: true });
      writeFileSync(join(promptDir, "browsing_prompt.md"), "Task: ${TASK}\nID: ${TASK_ID}\nReport: ${REPORT_FILE}", "utf-8");

      const result = loadBrowsePrompt("check notifications", 42, "abc123");
      expect(result).toContain("Task: check notifications");
      expect(result).toContain("ID: abc123");
      expect(result).toContain("browse_abc123_");
      expect(result).not.toContain("${TASK}");
      expect(result).not.toContain("${TASK_ID}");
    });
  });
});
