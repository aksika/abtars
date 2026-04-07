import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "../tests/helpers.js";
import { buildWakeUp } from "./wake-up-builder.js";

describe("wake-up-builder", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "abm-wakeup-"));
    // Set AGENT_BRIDGE_HOME so wake-up builder finds dailies
    process.env["AGENT_BRIDGE_HOME"] = tmpDir;
    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    delete process.env["AGENT_BRIDGE_HOME"];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for null db", () => {
    expect(buildWakeUp(null, 128000)).toBe("");
  });

  it("returns empty for tiny budget", () => {
    expect(buildWakeUp(mm.getDatabase(), 100)).toBe("");
  });

  it("includes ABM-L hint", () => {
    const result = buildWakeUp(mm.getDatabase()!, 128000);
    expect(result).toContain("Memory format:");
  });

  it("includes core memories when available", async () => {
    // Store a core memory
    await mm.editor.instantStore({
      chatId: 1, contentEn: "We use TypeScript for the project",
      contentOriginal: "test", memoryType: "fact", emotionScore: 0, topic: "coding",
    });
    // Promote to core
    mm.getDatabase()!.prepare("UPDATE extracted_memories SET tier = 'core' WHERE id = 1").run();

    const result = buildWakeUp(mm.getDatabase()!, 128000);
    expect(result).toContain("CORE MEMORY");
  });

  it("includes daily summaries when available", () => {
    const dailyDir = join(tmpDir, "memory", "daily");
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(join(dailyDir, "daily_2026-04-07.md"), "# Daily\nWorked on ABM v2 today.");

    const result = buildWakeUp(mm.getDatabase()!, 128000);
    expect(result).toContain("DAILY 2026-04-07");
  });

  it("respects budget — small context gets less content", () => {
    const dailyDir = join(tmpDir, "memory", "daily");
    mkdirSync(dailyDir, { recursive: true });
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dailyDir, `daily_2026-04-0${i}.md`), "# Daily\n" + "content ".repeat(100));
    }

    const small = buildWakeUp(mm.getDatabase()!, 4000); // 1% = 40 tokens
    const large = buildWakeUp(mm.getDatabase()!, 128000); // 1% = 1280 tokens
    expect(large.length).toBeGreaterThan(small.length);
  });
});
