import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateSnapshot } from "./sleep-state-gatherer.js";

// Must mock before import
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => "/nonexistent-home" };
});

import { loadSleepPrompt } from "./sleep-prompt-loader.js";

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    timestamp: "2026-03-15T10:00:00Z",
    workingDirs: [],
    dbStats: { messageCount: 100, compactionCount: 5, extractedMemoryCount: 50, embeddingCount: 0, sessionCount: 2 },
    fts5Health: { messages_fts: "ok", extracted_memories_fts: "ok", extracted_memories_original_fts: "ok" },
    diskUsageBytes: 10 * 1024 * 1024,
    diskBudgetBytes: 500 * 1024 * 1024,
    topicFiles: [],
    lastSleepAudit: "2026-03-14T08:00:00Z",
    wakeupDate: "2026-03-15",
    todoContents: "- Buy milk",
    cronContents: "[]",
    transcriptPaths: [],
    ...overrides,
  };
}

describe("loadSleepPrompt", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-prompt-"));
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces all ${VARIABLES} with snapshot values", () => {
    const templateDir = join(tmpDir, "persona");
    const { mkdirSync } = require("node:fs");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, "sleeping_prompt.md"),
      "Date: ${WAKEUP_DATE}\nAudit: ${LAST_SLEEP_AUDIT}\nDisk: ${DISK_USAGE_MB}/${DISK_BUDGET_MB} MB\nTodo: ${TODO_CONTENTS}",
    );
    process.cwd = () => tmpDir;

    const result = loadSleepPrompt(makeSnapshot());

    expect(result).toContain("Date: 2026-03-15");
    expect(result).toContain("Audit: 2026-03-14T08:00:00Z");
    expect(result).toContain("Disk: 10.0/500 MB");
    expect(result).toContain("Todo: - Buy milk");
    expect(result).not.toMatch(/\$\{[A-Z_]+\}/);
  });

  it("throws when template file not found", () => {
    process.cwd = () => tmpDir;
    expect(() => loadSleepPrompt(makeSnapshot())).toThrow("sleeping_prompt.md not found");
  });

  it("leaves unknown variables and warns", () => {
    const templateDir = join(tmpDir, "persona");
    const { mkdirSync } = require("node:fs");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, "sleeping_prompt.md"),
      "Known: ${WAKEUP_DATE} Unknown: ${NONEXISTENT_VAR}",
    );
    process.cwd = () => tmpDir;

    const result = loadSleepPrompt(makeSnapshot());

    expect(result).toContain("Known: 2026-03-15");
    expect(result).toContain("${NONEXISTENT_VAR}");
  });
});
