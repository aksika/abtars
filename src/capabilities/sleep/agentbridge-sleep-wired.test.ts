import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "abmind/memory-db.js";
import type Database from "better-sqlite3";

// Import the functions we need to test — they're not exported yet, so we test via the module
// For now, test the wired logic inline

function setupDb(tmpDir: string): Database.Database {
  const db = initializeDatabase(join(tmpDir, "memory.db"));
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
  return db;
}

describe("Sleep wired tasks", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-wired-"));
    mkdirSync(join(tmpDir, "sleep"), { recursive: true });
    db = setupDb(tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("garbage purge", () => {
    it("deletes messages marked >7 days ago in garbage.json", () => {
      const now = Date.now();
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'old noise', ?)").run(now);
      const msgId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

      const oldDate = new Date(now - 8 * 86400000).toISOString();
      writeFileSync(join(tmpDir, "garbage.json"), JSON.stringify({ [msgId]: oldDate }));

      // Simulate purge
      const garbage = JSON.parse(readFileSync(join(tmpDir, "garbage.json"), "utf-8")) as Record<string, string>;
      const cutoff = now - 7 * 86400000;
      const expired = Object.entries(garbage).filter(([, ts]) => new Date(ts).getTime() < cutoff);
      const ids = expired.map(([id]) => parseInt(id, 10));
      if (ids.length > 0) db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
      for (const [id] of expired) delete garbage[id];
      writeFileSync(join(tmpDir, "garbage.json"), JSON.stringify(garbage));

      expect(expired.length).toBe(1);
      const remaining = db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number };
      expect(remaining.cnt).toBe(0);
      expect(JSON.parse(readFileSync(join(tmpDir, "garbage.json"), "utf-8"))).toEqual({});
    });
  });

  describe("dedup consecutive", () => {
    it("deletes second consecutive identical message from same role", () => {
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'hello', 1000)").run();
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'hello', 2000)").run();

      const dupes = db.prepare(`
        SELECT b.id FROM messages a JOIN messages b
        ON a.user_id = b.user_id AND a.role = b.role
        AND TRIM(a.content) = TRIM(b.content)
        AND b.id > a.id
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.user_id = a.user_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
        )
      `).all() as Array<{ id: number }>;

      expect(dupes.length).toBe(1);
      db.prepare(`DELETE FROM messages WHERE id IN (${dupes.map(d => d.id).join(",")})`).run();
      expect((db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number }).cnt).toBe(1);
    });

    it("keeps both when different content", () => {
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'hello', 1000)").run();
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'world', 2000)").run();

      const dupes = db.prepare(`
        SELECT b.id FROM messages a JOIN messages b
        ON a.user_id = b.user_id AND a.role = b.role
        AND TRIM(a.content) = TRIM(b.content)
        AND b.id > a.id
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.user_id = a.user_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
        )
      `).all();

      expect(dupes.length).toBe(0);
    });

    it("dedupes across time gap (consecutive, not time-based)", () => {
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'retry msg', 1000)").run();
      // 3 hours later, same message
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('aksika', 's', 'user', 'retry msg', 10800000)").run();

      const dupes = db.prepare(`
        SELECT b.id FROM messages a JOIN messages b
        ON a.user_id = b.user_id AND a.role = b.role
        AND TRIM(a.content) = TRIM(b.content)
        AND b.id > a.id
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.user_id = a.user_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
        )
      `).all();

      expect(dupes.length).toBe(1);
    });
  });

  describe("anomaly auto-fixes", () => {
    it("sets trust=2 on decisions with trust<2", () => {
      const now = Date.now();
      db.prepare("INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, preserve_original, emotion_score, trust, classification) VALUES (1, 't', 't', 'decision', ?, ?, 0, 0, 0, 1)").run(now, now);

      const changes = db.prepare("UPDATE extracted_memories SET trust = 2 WHERE memory_type = 'decision' AND trust < 2").run().changes;
      expect(changes).toBe(1);

      const row = db.prepare("SELECT trust FROM extracted_memories").get() as { trust: number };
      expect(row.trust).toBe(2);
    });

    it("sets classification=1 on decisions with classification=0", () => {
      const now = Date.now();
      db.prepare("INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, preserve_original, emotion_score, classification) VALUES (1, 't', 't', 'decision', ?, ?, 0, 0, 0)").run(now, now);

      const changes = db.prepare("UPDATE extracted_memories SET classification = 1 WHERE memory_type = 'decision' AND classification = 0").run().changes;
      expect(changes).toBe(1);
    });

    it("sets credibility=3 on stale credibility=6 memories >7 days old", () => {
      const old = Date.now() - 10 * 86400000;
      db.prepare("INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, preserve_original, emotion_score, credibility) VALUES (1, 't', 't', 'fact', ?, ?, 0, 0, 6)").run(old, old);

      const changes = db.prepare("UPDATE extracted_memories SET credibility = 3 WHERE credibility = 6 AND created_at < ?").run(Date.now() - 7 * 86400000).changes;
      expect(changes).toBe(1);
    });
  });

  describe("state file", () => {
    it("writes and reads state file", () => {
      const statePath = join(tmpDir, "sleep", "sleep_20260330.lock");
      const state = { pid: 123, startedAt: Date.now(), steps: { identity: { status: "ok" as const, duration: 5.1 } } };
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(loaded.pid).toBe(123);
      expect(loaded.steps.identity.status).toBe("ok");
    });

    it("detects resume from partial state", () => {
      const statePath = join(tmpDir, "sleep", "sleep_20260330.lock");
      const state = {
        pid: 123, startedAt: Date.now(),
        steps: { identity: { status: "ok" }, retrospective: { status: "ok" }, gc: { status: "failed" } },
      };
      writeFileSync(statePath, JSON.stringify(state));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8"));
      const isResume = Object.values(loaded.steps).some((s: any) => s.status === "ok");
      const completedSteps = Object.entries(loaded.steps).filter(([, s]: any) => s.status === "ok" || s.status === "skipped").map(([k]) => k);

      expect(isResume).toBe(true);
      expect(completedSteps).toEqual(["identity", "retrospective"]);
    });
  });

  describe("lock file cleanup", () => {
    it("deletes lock files older than 2 days", () => {
      const sleepDir = join(tmpDir, "sleep");
      writeFileSync(join(sleepDir, "sleep_20260325.lock"), "123");
      writeFileSync(join(sleepDir, "sleep_20260329.lock"), "456");
      writeFileSync(join(sleepDir, "sleep_20260330.lock"), "789");

      const cutoff = new Date("2026-03-28").getTime();
      const { readdirSync, unlinkSync } = require("node:fs");
      for (const f of readdirSync(sleepDir) as string[]) {
        if (!f.endsWith(".lock")) continue;
        const match = f.match(/sleep_(\d{4})(\d{2})(\d{2})\.lock/);
        if (match && new Date(`${match[1]}-${match[2]}-${match[3]}`).getTime() < cutoff) {
          unlinkSync(join(sleepDir, f));
        }
      }

      expect(existsSync(join(sleepDir, "sleep_20260325.lock"))).toBe(false);
      expect(existsSync(join(sleepDir, "sleep_20260329.lock"))).toBe(true);
      expect(existsSync(join(sleepDir, "sleep_20260330.lock"))).toBe(true);
    });
  });
});
