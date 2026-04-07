import type Database from "better-sqlite3";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import { clampEmotionScore } from "./emotion-utils.js";
import { loadEmbedConfig, embedText } from "./ollama-embed.js";
import { logError, logInfo } from "./mem-logger.js";

const TAG = "memory-editor";

/** Handles all mutations on extracted memories: edit, store, merge, delete. */
export class MemoryEditor {
  constructor(private readonly db: Database.Database) {}

  /** Edit an existing extracted memory. Unified mutation path for all field updates. */
  editMemory(params: EditMemoryParams): EditMemoryResult {
    try {
      let targetIds: number[];
      if (params.memoryId != null) {
        targetIds = [params.memoryId];
      } else if (params.messageId != null && params.chatId != null) {
        const msg = this.db.prepare(
          "SELECT id FROM messages WHERE chat_id = ? AND platform_message_id = ?",
        ).get(params.chatId, params.messageId) as { id: number } | undefined;
        if (!msg) return { ok: false, error: "message not found" };
        const rows = this.db.prepare(
          "SELECT id FROM extracted_memories WHERE source_message_ids LIKE '%' || ? || '%'",
        ).all(String(msg.id)) as Array<{ id: number }>;
        if (rows.length === 0) return { ok: false, error: "no memories linked to this message" };
        targetIds = rows.map(r => r.id);
      } else {
        return { ok: false, error: "--memory-id or --message-id + --chat-id required" };
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      const fieldsUpdated: string[] = [];

      if (params.contentEn != null) { sets.push("content_en = ?"); values.push(params.contentEn.trim()); fieldsUpdated.push("content_en"); }
      if (params.contentOriginal != null) { sets.push("content_original = ?"); values.push(params.contentOriginal.trim()); fieldsUpdated.push("content_original"); }
      if (params.keyword !== undefined) { sets.push("preserved_keyword = ?"); values.push(params.keyword?.trim() || null); fieldsUpdated.push("keyword"); }
      if (params.memoryType != null) {
        const valid = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);
        if (!valid.has(params.memoryType)) return { ok: false, error: "invalid memory_type" };
        sets.push("memory_type = ?"); values.push(params.memoryType); fieldsUpdated.push("memory_type");
      }
      if (params.emotionScore != null) { sets.push("emotion_score = ?"); values.push(clampEmotionScore(params.emotionScore)); fieldsUpdated.push("emotion_score"); }
      if (params.confidence != null) { sets.push("confidence = ?"); values.push(params.confidence); fieldsUpdated.push("confidence"); }
      if (params.trust != null) {
        if (params.trust < 0 || params.trust > 3) return { ok: false, error: "trust must be 0-3" };
        sets.push("trust = ?"); values.push(params.trust); fieldsUpdated.push("trust");
      }
      if (params.integrity != null) {
        if (params.integrity < 0 || params.integrity > 3) return { ok: false, error: "integrity must be 0-3" };
        sets.push("integrity = ?"); values.push(params.integrity); fieldsUpdated.push("integrity");
      }
      if (params.credibility != null) {
        if (params.credibility < 1 || params.credibility > 6) return { ok: false, error: "credibility must be 1-6" };
        sets.push("credibility = ?"); values.push(params.credibility); fieldsUpdated.push("credibility");
      }
      if (params.classification != null) {
        if (params.classification < 0 || params.classification > 3) return { ok: false, error: "classification must be 0-3" };
        fieldsUpdated.push("classification");
      }
      if (params.relevanceScore != null) {
        const raw = params.relevanceScore;
        if (typeof raw === "string" && /^[+-]\d+$/.test(raw)) {
          sets.push("relevance_score = relevance_score + ?"); values.push(parseInt(raw, 10));
        } else {
          sets.push("relevance_score = ?"); values.push(typeof raw === "string" ? parseInt(raw, 10) : raw);
        }
        fieldsUpdated.push("relevance_score");
      }
      if (params.topic != null) { sets.push("topic = ?"); values.push(params.topic); fieldsUpdated.push("topic"); }
      if (params.tier != null) {
        if (params.tier !== "core" && params.tier !== "general") return { ok: false, error: "tier must be 'core' or 'general'" };
        sets.push("tier = ?"); values.push(params.tier); fieldsUpdated.push("tier");
      }
      if (params.validTo != null) { sets.push("valid_to = ?"); values.push(params.validTo || null); fieldsUpdated.push("valid_to"); }

      if (sets.length === 0 && params.classification == null) return { ok: false, error: "no fields to update" };
      if (params.dryRun) return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };

      const now = Date.now();
      const editedBy = params.caller ?? null;
      const contentChanged = params.contentEn != null;

      for (const id of targetIds) {
        if (params.classification != null) {
          const row = this.db.prepare("SELECT classification FROM extracted_memories WHERE id = ?").get(id) as { classification: number } | undefined;
          if (!row) continue;
          if (row.classification === 3 && params.classification < 3 && !params.userOverride) {
            return { ok: false, error: "cannot declassify SECRET without --user-override" };
          }
          if (row.classification === 2 && params.classification < row.classification && params.classification !== 1) {
            return { ok: false, error: "CONFIDENTIAL can only be declassified to RESTRICTED (1)" };
          }
        }

        const exists = this.db.prepare("SELECT id FROM extracted_memories WHERE id = ?").get(id);
        if (!exists) continue;

        const finalSets = [...sets];
        const finalValues = [...values];
        if (params.classification != null) { finalSets.push("classification = ?"); finalValues.push(params.classification); }
        finalSets.push("edited_at = ?", "edited_by = ?");
        finalValues.push(now, editedBy);
        if (contentChanged) finalSets.push("embedding = NULL");

        finalValues.push(id);
        this.db.prepare(`UPDATE extracted_memories SET ${finalSets.join(", ")} WHERE id = ?`).run(...finalValues);
        if (contentChanged && params.contentEn) this.embedNewMemory(params.contentEn.trim());
      }

      logInfo(TAG, `editMemory: updated ${targetIds.length} memories [${fieldsUpdated.join(",")}] caller=${editedBy}`);
      return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, "editMemory failed", err);
      return { ok: false, error: message };
    }
  }

  /** Immediately persist a memory from the agent's instant_store tool. */
  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    try {
      if (!params.contentEn?.trim()) return { stored: false, memoriesCount: 0, error: "content-en is required" };
      if (!params.contentOriginal?.trim()) return { stored: false, memoriesCount: 0, error: "content-original is required" };
      const validTypes = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);
      if (!validTypes.has(params.memoryType)) return { stored: false, memoriesCount: 0, error: "invalid memory_type" };

      const emotionScore = clampEmotionScore(params.emotionScore);
      const now = Date.now();

      this.db.prepare(
        `INSERT INTO extracted_memories
           (chat_id, content_original, content_en, memory_type, source_timestamp,
            preserve_original, preserved_keyword, emotion_score, created_at,
            confidence, source_message_ids, classification, trust, integrity, credibility,
            topic, tier, valid_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'general', ?)`,
      ).run(
        params.chatId, params.contentOriginal.trim(), params.contentEn.trim(),
        params.memoryType, now, 1, params.keyword?.trim() || null, emotionScore, now,
        params.confidence ?? 3, params.sourceMessageIds?.trim() || null,
        params.classification ?? 1, params.trust ?? 0, params.integrity ?? 2, params.credibility ?? 6,
        params.topic ?? "general", new Date(now).toISOString().slice(0, 10),
      );

      this.embedNewMemory(params.contentEn.trim());
      logInfo(TAG, `Instant store: persisted memory for chat ${params.chatId} (type=${params.memoryType}, emotion=${emotionScore})`);
      return { stored: true, memoriesCount: 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Instant store failed for chat ${params.chatId}`, err);
      return { stored: false, memoriesCount: 0, error: message };
    }
  }

  /** Adjust relevance_score on an existing extracted memory. */
  adjustRelevance(id: number, delta: number): void {
    this.editMemory({ memoryId: id, relevanceScore: `${delta >= 0 ? "+" : ""}${delta}` });
  }

  /** Reclassify a memory's confidentiality level. */
  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    return this.editMemory({ memoryId: id, classification: level, userOverride });
  }

  /** Merge two extracted memories: keep newer, combine Darwinism scores, delete older. */
  mergeMemories(idA: number, idB: number): { merged: boolean; keptId: number; deletedId: number } | { merged: false; error: string } {
    const rows = this.db.prepare(
      "SELECT id, recall_count, relevance_score, confidence, created_at FROM extracted_memories WHERE id IN (?, ?)",
    ).all(idA, idB) as Array<{ id: number; recall_count: number; relevance_score: number; confidence: number; created_at: number }>;

    if (rows.length !== 2) return { merged: false, error: "one or both IDs not found" };
    const [older, newer] = rows.sort((a, b) => a.created_at - b.created_at) as [typeof rows[0], typeof rows[0]];

    this.db.prepare(`
      UPDATE extracted_memories SET
        recall_count = recall_count + ?, relevance_score = MAX(relevance_score, ?),
        confidence = MAX(confidence, ?), integrity = 3
      WHERE id = ?
    `).run(older!.recall_count ?? 0, older!.relevance_score ?? 0, older!.confidence ?? 3, newer!.id);

    this.db.prepare("DELETE FROM extracted_memories WHERE id = ?").run(older!.id);

    const kept = this.db.prepare("SELECT content_en FROM extracted_memories WHERE id = ?").get(newer!.id) as { content_en: string } | undefined;
    if (kept) this.embedNewMemory(kept.content_en);

    return { merged: true, keptId: newer!.id, deletedId: older!.id };
  }

  /** Cascade deletion through all storage layers for the given message IDs. */
  cascadeDelete(messageIds: number[], chatId: number): ForgetResult {
    const result: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    if (messageIds.length === 0) return result;
    try {
      const ph = messageIds.map(() => "?").join(",");
      result.embeddingsRemoved = this.db.prepare(`DELETE FROM embeddings WHERE message_id IN (${ph})`).run(...messageIds).changes;
      result.messagesRemoved = this.db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...messageIds).changes;
      logInfo(TAG, `Cascade delete for chat ${chatId}: ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings`);
    } catch (err) {
      logError(TAG, `Cascade delete failed for chat ${chatId}`, err);
    }
    return result;
  }

  /** Embed a newly inserted memory (fire-and-forget). */
  private embedNewMemory(contentEn: string): void {
    const cfg = loadEmbedConfig();
    if (!cfg.enabled) return;
    embedText(cfg, contentEn).then(vec => {
      if (!vec) return;
      this.db.prepare(
        "UPDATE extracted_memories SET embedding = ? WHERE content_en = ? AND embedding IS NULL"
      ).run(Buffer.from(vec.buffer), contentEn);
    }).catch(() => {});
  }
}
