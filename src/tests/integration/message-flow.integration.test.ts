/**
 * Integration: message flow — store → recall → citation round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createHarness, memoryDb, detectCitations, type IntegrationHarness } from "./harness.js";
import { getPeerRecallCap, clearPeerConfigCache } from "../../components/peer-config.js";

describe("message-flow integration", () => {
  let h: IntegrationHarness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => h.cleanup());

  it("store → recall round-trip", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "User prefers TypeScript over JavaScript for all projects",
      contentOriginal: "TypeScript-et preferálja", memoryType: "preference", emotionScore: 0,
      emotionTags: "conviction", topic: "coding",
    });

    const result = await h.recallOwned("recall_normal", "User prefers TypeScript over JavaScript");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.excerpt).toContain("TypeScript");
  });

  it("recordMessage persists to DB", () => {
    h.memory.recordMessage({
      role: "user", content: "Hello world", timestamp: Date.now(),
      userId: "u1", sessionId: "sess_1", platformMessageId: 100,
    });

    const db = memoryDb(h.memory);
    const row = db.prepare("SELECT content, role FROM messages WHERE platform_message_id = 100").get() as { content: string; role: string };
    expect(row.content).toBe("Hello world");
    expect(row.role).toBe("user");
  });

  it("citation detection → cited_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "The deployment pipeline uses GitHub Actions with staging",
      contentOriginal: "deployment", memoryType: "fact", emotionScore: 0, topic: "devops",
    });

    const result = await h.recallOwned("recall_normal", "deployment pipeline uses GitHub Actions");
    expect(result.items.length).toBeGreaterThan(0);
    const recalledHits = result.items.map((item, index) => ({ id: index + 1, contentEn: item.excerpt }));

    // Agent response cites the memory (≥20 char substring)
    const response = "I see that the deployment pipeline uses GitHub Actions with staging environment. I'll configure accordingly.";
    const citedIds = detectCitations(response, recalledHits);
    expect(citedIds.length).toBeGreaterThan(0);
  });

  it("classification gate — class 2 hidden from maxClass 1", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "My salary is 150k annually",
      contentOriginal: "salary", memoryType: "fact", emotionScore: 0,
      classification: 2, topic: "finance",
    });
    // The owned core serves built projections; build before asserting.
    await h.recallOwned("recall_normal", "salary");

    const restricted = await h.memory.recall({
      contract: "owned-v1", profile: "recall_normal", identity: { principal: "u1" },
      query: { text: "salary" }, filters: { classificationCeiling: 1 }, capacity: { maxItems: 10 },
    });
    expect(restricted.items.length).toBe(0);

    const allowed = await h.memory.recall({
      contract: "owned-v1", profile: "recall_normal", identity: { principal: "u1" },
      query: { text: "salary" }, filters: { classificationCeiling: 2 }, capacity: { maxItems: 10 },
    });
    expect(allowed.items.length).toBeGreaterThan(0);
  });

  it("peer clearance gate — recall capped at peer maxClass, ownership enforced (#1790)", async () => {
    // Real peer loader on temporary config; the production cap helper sets
    // the recall ceiling. Peer-owned rows are seeded by briefly assuming each
    // peer as the primary owner (the store creation gate reads ABMIND_USER_ID
    // per call); class-3 needs a sealed label plus ABMIND_KEY.
    const savedHome = process.env.ABTARS_HOME;
    const savedKey = process.env.ABMIND_KEY;
    const homeDir = mkdtempSync(join(tmpdir(), "abtars-peer-gate-"));
    mkdirSync(join(homeDir, "config"), { recursive: true });
    writeFileSync(join(homeDir, "config", "peers.json"), JSON.stringify({
      self: { name: "kp-test", signingKey: "k", tribeToken: "t" },
      peers: {
        px1: { host: "10.0.1.1", port: 7100, verifyKey: "k1", maxClass: 1 },
        px2: { host: "10.0.1.2", port: 7100, verifyKey: "k2", maxClass: 2 },
        px3: { host: "10.0.1.3", port: 7100, verifyKey: "k3", maxClass: 3 },
      },
    }));
    process.env.ABTARS_HOME = homeDir;
    process.env.ABMIND_KEY = randomBytes(32).toString("hex");
    clearPeerConfigCache();
    try {
      const token = (peer: string, level: number | "x") => `zqx${peer}c${level}`;
      const topicOf = (peer: string, level: number | "x") => `pg-${peer}-${level}`;
      async function storeAs(owner: string, row: {
        contentEn: string; contentOriginal: string;
        memoryType: "fact" | "secret"; classification: number;
        sealedLabel?: string; sealedKeyword?: string; topic: string;
      }): Promise<void> {
        process.env.ABTARS_HOME = homeDir;
        process.env.ABMIND_USER_ID = owner;
        try {
          const res = await h.memory.editor.instantStore({
            userId: owner, emotionScore: 0, ...row,
          });
          expect(res.stored).toBe(true);
        } finally {
          process.env.ABMIND_USER_ID = "u1";
        }
      }

      // Peer-owned markers at class 0/1/2 (+ sealed 3) per peer, each under
      // its own topic so fuzzy stages cannot cross-match sibling markers.
      for (const peer of ["px0", "px1", "px2", "px3"]) {
        for (const level of [0, 1, 2]) {
          await storeAs(peer, {
            contentEn: `${token(peer, level)} clearance marker ${peer} level ${level} harbor`,
            contentOriginal: `${token(peer, level)} reference`,
            memoryType: "fact", classification: level, topic: topicOf(peer, level),
          });
        }
        // Sealed direct stores are refused by the new model; seed the sealed
        // row the way the reviewed seal flow leaves it (classification 3,
        // encrypted, label-only evidence).
        {
          const now = Date.now();
          memoryDb(h.memory).prepare(
            `INSERT INTO long_term_memories
               (user_id, memory_type, content, content_original, authority, applicability_scope,
                valid_from, revision, provenance, evidence, classification, encrypted, created_at, updated_at)
             VALUES (?, 'secret', ?, ?, 'inference', '{"scope":"general"}',
                date('now'), 1, '{}', ?, 3, 1, ?, ?)`,
          ).run(
            peer,
            `${token(peer, 3)} sealed clearance marker label`,
            `${token(peer, 3)} label reference`,
            JSON.stringify([{ kind: "direct", ref: "direct", excerpt: `${token(peer, 3)} sealed clearance marker label`, classification: 3 }]),
            now, now,
          );
        }
      }
      // Another owner's class-2 row: visible to u1, never to a peer principal.
      await storeAs("u1", {
        contentEn: `${token("other", 2)} foreign owner confidential marker quarry`,
        contentOriginal: `${token("other", 2)} reference`,
        memoryType: "fact", classification: 2, topic: topicOf("other", 2),
      });

      const { buildRecallProjection } = await import("abmind");
      const db = memoryDb(h.memory);
      // #1928 M4 — one serving generation per build: (re)build for the
      // principal under test before its recall attempts.
      const buildFor = (owner: string): void => {
        expect(buildRecallProjection(db, owner, { verifiedBackup: true }).ok).toBe(true);
      };
      // Production caps: absent => 0, declared 3 recalls as 2.
      expect(getPeerRecallCap("px0")).toBe(0);
      expect(getPeerRecallCap("px1")).toBe(1);
      expect(getPeerRecallCap("px2")).toBe(2);
      expect(getPeerRecallCap("px3")).toBe(2);

      const cases: Array<{ peer: string; allowed: boolean[] }> = [
        { peer: "px0", allowed: [true, false, false, false] },
        { peer: "px1", allowed: [true, true, false, false] },
        { peer: "px2", allowed: [true, true, true, false] },
        { peer: "px3", allowed: [true, true, true, false] },
      ];
      for (const { peer, allowed } of cases) {
        buildFor(peer);
        const cap = getPeerRecallCap(peer);
        for (const level of [0, 1, 2, 3]) {
          const t = token(peer, level);
          const res = await h.memory.recall({
            contract: "owned-v1", profile: "recall_normal", identity: { principal: peer },
            query: { text: t }, filters: { classificationCeiling: cap }, capacity: { maxItems: 10 },
          });
          if (allowed[level]!) {
            // Presence asserted: an empty response must not pass.
            expect(res.items.length).toBeGreaterThan(0);
            expect(res.items.some(r => (r.excerpt ?? "").toLowerCase().includes(t))).toBe(true);
          } else {
            expect(res.items.length).toBe(0);
          }
        }
      }

      // Ownership negative control: foreign class-2 is hidden from peers at
      // cap 2 (and 3-declared), but visible to its owner.
      for (const peer of ["px2", "px3"]) {
        const res = await h.memory.recall({
          contract: "owned-v1", profile: "recall_normal", identity: { principal: peer },
          query: { text: token("other", 2) },
          filters: { classificationCeiling: getPeerRecallCap(peer) }, capacity: { maxItems: 10 },
        });
        expect(res.items.length).toBe(0);
      }
      buildFor("u1");
      const owned = await h.memory.recall({
        contract: "owned-v1", profile: "recall_normal", identity: { principal: "u1" },
        query: { text: token("other", 2) },
        filters: { classificationCeiling: 2 }, capacity: { maxItems: 10 },
      });
      expect(owned.items.length).toBeGreaterThan(0);
    } finally {
      if (savedHome === undefined) delete process.env.ABTARS_HOME;
      else process.env.ABTARS_HOME = savedHome;
      if (savedKey === undefined) delete process.env.ABMIND_KEY;
      else process.env.ABMIND_KEY = savedKey;
      process.env.ABMIND_USER_ID = "u1";
      clearPeerConfigCache();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
