/**
 * Integration test harness — real abmind (SQLite in tmpdir) + mocked transport.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, type MemoryConfig, MEMORY_CONFIG_DEFAULTS, detectCitations, type RecallMemoryRef } from "abmind";

export interface IntegrationHarness {
  memory: MemoryManager;
  tmpDir: string;
  cleanup: () => void;
}

export async function createHarness(): Promise<IntegrationHarness> {
  const tmpDir = mkdtempSync(join(tmpdir(), "abtars-integration-"));
  const config: MemoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir };
  const memory = new MemoryManager(config);
  await memory.initialize();
  return {
    memory,
    tmpDir,
    cleanup: () => { memory.close(); rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

export { detectCitations, type RecallMemoryRef };
