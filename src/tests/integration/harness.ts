/**
 * Integration test harness — real abmind (SQLite in tmpdir) + mocked transport.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database } from "better-sqlite3";
import { MemoryManager, type MemoryConfig, MEMORY_CONFIG_DEFAULTS, detectCitations, type RecallMemoryRef } from "abmind";

/**
 * #1658/#1660: abmind's Master-only creation gate resolves the primary owner
 * from ABMIND_USER_ID (never "master" placeholders). The harness must pin a
 * canonical test owner so stores for `u1` are not rejected against whatever
 * the host manifest resolves.
 */
const TEST_PRIMARY_OWNER = "u1";


function pinTestOwner(): string | undefined {
  const saved = process.env["ABMIND_USER_ID"];
  process.env["ABMIND_USER_ID"] = TEST_PRIMARY_OWNER;
  return saved;
}

function restoreTestOwner(saved: string | undefined): void {
  if (saved === undefined) delete process.env["ABMIND_USER_ID"];
  else process.env["ABMIND_USER_ID"] = saved;
}

export interface IntegrationHarness {
  memory: MemoryManager;
  /**
   * #1928 M4 — owned recall over a freshly built serving generation, so
   * integration assertions run the same contract as production routes.
   */
  recallOwned: (profile: "recall_fast" | "recall_normal" | "recall_full", text: string, userId?: string) => Promise<import("abmind").OwnedRecallPacket>;
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
  const savedOwner = pinTestOwner();
  const tmpDir = mkdtempSync(join(tmpdir(), "abtars-integration-"));
  const config: MemoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir };
  const memory = new MemoryManager(config);
  await memory.initialize({ skipEmbeddingCheck: true });
  return {
    memory,
    recallOwned: async (profile, text, userId = TEST_PRIMARY_OWNER) => {
      const { buildRecallProjection } = await import("abmind");
      const db = memoryDb(memory);
      const built = buildRecallProjection(db, userId, { verifiedBackup: true });
      if (!built.ok) throw new Error(`projection build failed: ${JSON.stringify(built)}`);
      return memory.recall({
        contract: "owned-v1",
        profile,
        identity: { principal: userId },
        ...(profile === "recall_fast" ? { rawTurn: text } : { query: { text } }),
        capacity: { maxItems: 10 },
      });
    },
    tmpDir,
    cleanup: () => { memory.close(); rmSync(tmpDir, { recursive: true, force: true }); restoreTestOwner(savedOwner); },
  };
}
export { detectCitations, type RecallMemoryRef };
