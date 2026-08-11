/**
 * Integration test harness — real abmind (SQLite in tmpdir) + mocked transport.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database } from "better-sqlite3";
import { MemoryManager, type MemoryConfig, MEMORY_CONFIG_DEFAULTS, detectCitations, type RecallMemoryRef } from "abmind";

export interface IntegrationHarness {
  memory: MemoryManager;
  tmpDir: string;
  cleanup: () => void;
}

/**
 * Test-only raw handle to abmind's SQLite db. abmind no longer exposes
 * getDatabase()/getDb() publicly (#1448) — tests reach the handle through
 * the private field, which is compile-time-only encapsulation anyway.
 */
export function memoryDb(memory: MemoryManager): Database {
  return (memory as unknown as { db: Database | null }).db!;
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
