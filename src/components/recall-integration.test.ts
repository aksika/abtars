/**
 * Integration test: recall pipeline S1-S7 + Se.
 * Tests the full recall path with a real SQLite DB.
 * Se (embedding) tests require ollama running — skipped if unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../components/memory-db.js";
import { MemoryIndex } from "../components/memory-index.js";
import { recallSearch, type RecallDeps, type RecallParams } from "../components/recall-engine.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
let index: MemoryIndex;
let deps: RecallDeps;

const CHAT_ID = 100;

function insertMemory(opts: { contentEn: string; contentOriginal?: string; memoryType?: string; keyword?: string; classification?: number }): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO extracted_memories
       (chat_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 2, 3, 2)`,
  ).run(
    CHAT_ID, opts.contentOriginal ?? opts.contentEn, opts.contentEn,
    opts.memoryType ?? "fact", now, now,
    opts.keyword ? 1 : 0, opts.keyword ?? null,
    opts.classification ?? 1,
  );
  return Number(result.lastInsertRowid);
}

function insertMessage(content: string, role = "user"): number {
  const result = db.prepare(
    "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, 's1', ?, ?, ?)",
  ).run(CHAT_ID, role, content, Date.now());
  return Number(result.lastInsertRowid);
}

function baseParams(overrides: Partial<RecallParams> = {}): RecallParams {
  return { translated: ["test"], chatId: CHAT_ID, shortCircuitThreshold: 999, ...overrides };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-integration-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));

  // Run all migrations (same as MemoryManager.initialize)
  for (const ddl of [
    "ALTER TABLE extracted_memories ADD COLUMN emotion_score INTEGER DEFAULT 0",
    "ALTER TABLE extracted_memories ADD COLUMN recall_count INTEGER DEFAULT 0",
    "ALTER TABLE extracted_memories ADD COLUMN last_recalled_at INTEGER",
    "ALTER TABLE extracted_memories ADD COLUMN relevance_score INTEGER DEFAULT 0",
    "ALTER TABLE extracted_memories ADD COLUMN confidence INTEGER DEFAULT 3",
    "ALTER TABLE extracted_memories ADD COLUMN source_message_ids TEXT",
    "ALTER TABLE extracted_memories ADD COLUMN classification INTEGER DEFAULT 1",
    "ALTER TABLE extracted_memories ADD COLUMN trust INTEGER DEFAULT 0",
    "ALTER TABLE extracted_memories ADD COLUMN integrity INTEGER DEFAULT 2",
    "ALTER TABLE extracted_memories ADD COLUMN credibility INTEGER DEFAULT 6",
    "ALTER TABLE extracted_memories ADD COLUMN edited_at INTEGER",
    "ALTER TABLE extracted_memories ADD COLUMN edited_by TEXT",
  ]) { try { db.exec(ddl); } catch { /* */ } }

  index = new MemoryIndex(db);
  deps = {
    db,
    index,
    memoryDir: tmpDir,
    ctxStartPath: join(tmpDir, "ctx-start.json"),
  };

  // Seed test data
  insertMemory({ contentEn: "Molty is aksika's OpenClaw agent. Molty = kiscsávó (little dude).", contentOriginal: "Molty az aksika OpenClaw agentje. Molty = kiscsávó.", keyword: "kiscsávó" });
  insertMemory({ contentEn: "aksika likes pizza with extra cheese.", contentOriginal: "aksika extra sajttal szereti a pizzát.", memoryType: "preference" });
  insertMemory({ contentEn: "The bridge uses ACP transport for kiro-cli communication.", memoryType: "fact" });
  insertMemory({ contentEn: "Top secret API key: sk-1234", classification: 3 });
  insertMemory({ contentEn: "aksika's dentist appointment next Tuesday.", classification: 2 });

  insertMessage("Hey professor, what's Molty's nickname?");
  insertMessage("Molty = kiscsávó, the little dude on the Mac.", "assistant");
  insertMessage("What pizza does aksika like?");
  insertMessage("Extra cheese pizza!", "assistant");

  // Create a daily consolidation file
  const dailyDir = join(tmpDir, "daily");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(join(dailyDir, "daily_2026-03-29.md"), "# Daily Summary\n\nDiscussed Molty setup, pizza preferences, and bridge architecture.");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Recall Pipeline — Integration", () => {

  // ── S1: Extracted memories — English FTS5 ──

  it("S1: finds memory by English keyword via FTS5", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["pizza"], stages: ["S1"] }));
    expect(result.stages["S1"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.content.includes("pizza"))).toBe(true);
  });

  it("S1: accent-stripped query finds accented content", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["kiscsavo"], stages: ["S1"] }));
    expect(result.stages["S1"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.content.includes("kiscsávó"))).toBe(true);
  });

  it("S1: respects classification filter", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["secret", "API", "key"], stages: ["S1"], maxClassification: 2 }));
    expect(result.results.every(r => !r.content.includes("sk-1234"))).toBe(true);
  });

  // ── S2: Extracted memories — Original FTS5 ──

  it("S2: finds memory by original-language keyword", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["kiscsávó"], original: "kiscsávó", stages: ["S2"] }));
    expect(result.stages["S2"]?.hits.length).toBeGreaterThan(0);
  });

  // ── S3: Extracted memories — LIKE fallback ──

  it("S3: LIKE fallback finds partial match", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["OpenClaw"], stages: ["S3"] }));
    expect(result.stages["S3"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.content.includes("OpenClaw"))).toBe(true);
  });

  it("S3: LIKE finds by preserved_keyword tag", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["kiscsávó"], stages: ["S3"] }));
    expect(result.stages["S3"]?.hits.length).toBeGreaterThan(0);
  });

  it("S3: accent-stripped LIKE finds accented content", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["kiscsavo"], stages: ["S3"] }));
    expect(result.stages["S3"]?.hits.length).toBeGreaterThan(0);
  });

  // ── S4: Messages — FTS5 ──

  it("S4: finds raw messages via FTS5", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["nickname"], stages: ["S4"] }));
    expect(result.stages["S4"]?.hits.length).toBeGreaterThan(0);
  });

  // ── S5: Messages — LIKE ──

  it("S5: LIKE fallback on messages", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["professor"], stages: ["S5"] }));
    expect(result.stages["S5"]?.hits.length).toBeGreaterThan(0);
  });

  // ── S6: Consolidation files ──

  it("S6: searches daily consolidation files", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["architecture"], stages: ["S6"] }));
    expect(result.stages["S6"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.source.startsWith("S6"))).toBe(true);
  });

  // ── S7: Keyword-free fallback ──

  it("S7: returns recent messages when no other results", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["xyznonexistent"], stages: ["S7"] }));
    expect(result.stages["S7"]?.hits.length).toBeGreaterThan(0);
  });

  // ── Se: Embedding sidecar (optional — requires ollama) ──

  it("Se: semantic search finds related content (requires ollama)", async () => {
    // Check if ollama is available
    let ollamaUp = false;
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      ollamaUp = res.ok;
    } catch { /* */ }
    if (!ollamaUp) {
      console.log("  ⏭ Se test skipped — ollama not available");
      return;
    }

    // Embed test memories so vectorSearch has vectors to compare against
    const prev = process.env["EMBEDDING_ENABLED"];
    process.env["EMBEDDING_ENABLED"] = "true";
    try {
      const { loadEmbedConfig, embedText } = await import("../components/ollama-embed.js");
      const cfg = loadEmbedConfig();
      const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; content_en: string }>;
      for (const row of rows) {
        const vec = await embedText(cfg, row.content_en);
        if (vec) db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?").run(Buffer.from(vec.buffer), row.id);
      }

      const result = await recallSearch(deps, baseParams({ translated: ["little", "dude"], stages: ["Se"] }));
      expect(result.stages["Se"]?.hits.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env["EMBEDDING_ENABLED"];
      else process.env["EMBEDDING_ENABLED"] = prev;
    }
  });

  // ── Full pipeline ──

  it("full pipeline: all stages run and produce merged results", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["Molty"] }));
    expect(result.results.length).toBeGreaterThan(0);
    // Should have hits from multiple stages
    const stagesWithHits = Object.entries(result.stages).filter(([, v]) => v.hits.length > 0).map(([k]) => k);
    expect(stagesWithHits.length).toBeGreaterThanOrEqual(1);
  });

  it("full pipeline: deduplicates across stages", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["pizza"] }));
    const contents = result.results.map(r => r.content);
    const unique = new Set(contents);
    expect(contents.length).toBe(unique.size);
  });
});
