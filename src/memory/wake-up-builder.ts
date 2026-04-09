/**
 * wake-up-builder.ts — Build session-start memory context.
 * 1% of context window budget. Greedy fill: core → emotional highlights → dailies → weekly → quarterly.
 * ABM-L rendered on the fly from content_en (frontier models) or English (budget models).
 */

import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "./mem-paths.js";
import { pickLevel, renderWakeUp, compressDailySummary } from "./wake-up-renderer.js";
import { compress } from "./memory-compressor.js";
import { localMonth } from "../utils/local-time.js";
import { renderTimelines, type TimelineMemory } from "./timeline-builder.js";

const ABM_L_HINT = "Memory format: [TYPE+FLAGS|topic|emotion|confidence|date] content. Types: F=fact D=decision P=preference E=event L=lesson. Flags: T=technical C=correction V=pivot O=origin M=milestone. @name=entity. >over=chose over. →=leads to. |=list separator.";

/** Rough token estimate: ~4 chars per token. */
function tokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Render a memory to ABM-L on the fly from content_en. */
function renderMemory(row: { content_en: string; topic: string; emotion_tags: string | null; importance_flags: string | null; memory_type: string | null; confidence: number | null; created_at: number }): string {
  return compress({
    content_en: row.content_en,
    topic: row.topic ?? "general",
    emotion_tags: row.emotion_tags ?? "",
    importance_flags: row.importance_flags ?? "",
    memory_type: row.memory_type ?? "fact",
    confidence: row.confidence ?? 3,
    date: localMonth(new Date(row.created_at)),
  });
}

/** Load core-tier memories from DB, render to ABM-L on the fly. */
function loadCoreTier(db: Database.Database, level: ReturnType<typeof pickLevel>): string {
  const rows = db.prepare(
    `SELECT content_en, topic, emotion_arc, emotion_tags, importance_flags, memory_type, confidence, created_at
     FROM extracted_memories
     WHERE tier = 'core' AND valid_to IS NULL AND content_en IS NOT NULL
     ORDER BY topic, created_at DESC`,
  ).all() as Array<{ content_en: string; topic: string; emotion_arc: string | null; emotion_tags: string | null; importance_flags: string | null; memory_type: string | null; confidence: number | null; created_at: number }>;

  if (rows.length === 0) return "";
  const rendered = rows.map(r => ({ content_compressed: renderMemory(r), topic: r.topic, emotion_arc: r.emotion_arc }));
  return renderWakeUp(rendered, level);
}

/** Load recent daily summaries as ABM-L (or raw if no compressed version). */
function loadDailies(maxDays: number): string[] {
  const dailyDir = join(agentBridgeHome(), "memory", "daily");
  if (!existsSync(dailyDir)) return [];

  const files = readdirSync(dailyDir)
    .filter(f => f.startsWith("daily_") && f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, maxDays);

  return files.map(f => {
    const content = readFileSync(join(dailyDir, f), "utf-8").trim();
    const date = f.replace("daily_", "").replace(".md", "");
    // Compress daily to ABM-L bullet points
    const compressed = compressDailySummary(content, date);
    return compressed || `[DAILY ${date}]\n${content.length > 400 ? content.slice(0, 397) + "..." : content}`;
  });
}

/** Load latest weekly/quarterly summary. */
function loadSummary(type: "weekly" | "quarterly"): string | null {
  const dir = join(agentBridgeHome(), "memory", type);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse();
  if (files.length === 0) return null;

  const content = readFileSync(join(dir, files[0]!), "utf-8").trim();
  const truncated = content.length > 600 ? content.slice(0, 597) + "..." : content;
  return `[${type.toUpperCase()}]\n${truncated}`;
}

/**
 * Build memory context for session start.
 * Budget: 1% of context window. Greedy fill by priority.
 */
/** Load emotionally strong memories not in core tier, render ABM-L on the fly. */
function loadEmotionalHighlights(db: Database.Database): string {
  const rows = db.prepare(
    `SELECT content_en, topic, emotion_tags, importance_flags, memory_type, confidence, created_at, emotion_context FROM extracted_memories
     WHERE valid_to IS NULL AND content_en IS NOT NULL
       AND ABS(COALESCE(emotion_score, 0)) >= 3 AND tier != 'core'
     ORDER BY ABS(emotion_score) DESC, created_at DESC LIMIT 10`,
  ).all() as Array<{ content_en: string; topic: string; emotion_tags: string | null; importance_flags: string | null; memory_type: string | null; confidence: number | null; created_at: number; emotion_context: string | null }>;
  if (rows.length === 0) return "";
  const lines = rows.map(r => {
    const abml = renderMemory(r);
    const ctx = r.emotion_context ? ` (${r.emotion_context})` : "";
    return `${abml}${ctx}`;
  });
  return `[EMOTIONAL HIGHLIGHTS — ${rows.length} entries]\n${lines.join("\n")}`;
}

export function buildWakeUp(db: Database.Database | null, ctxWindowSize: number): string {
  if (!db) return "";

  const budget = Math.floor(ctxWindowSize * 0.01);
  if (budget < 20) return "";

  const level = pickLevel(budget);
  let remaining = budget;
  const parts: string[] = [ABM_L_HINT];
  remaining -= tokenCount(ABM_L_HINT);

  // Priority 1: core memories
  const core = loadCoreTier(db, level);
  if (core && tokenCount(core) <= remaining) {
    parts.push(core);
    remaining -= tokenCount(core);
  } else if (core) {
    const lines = core.split("\n");
    let partial = "";
    for (const line of lines) {
      if (tokenCount(partial + line) > remaining) break;
      partial += line + "\n";
    }
    if (partial) { parts.push(partial.trim()); remaining -= tokenCount(partial); }
  }

  // Priority 2: memory timelines (narrative arcs from general-tier)
  if (remaining > 200) {
    const tlRows = db.prepare(
      `SELECT id, content_en, topic, memory_type, emotion_tags, importance_flags, confidence, created_at, emotion_context
       FROM extracted_memories
       WHERE tier != 'core' AND valid_to IS NULL AND content_en IS NOT NULL
       ORDER BY topic, created_at DESC`,
    ).all() as TimelineMemory[];
    if (tlRows.length >= 2) {
      const { timelines } = renderTimelines(tlRows);
      if (timelines.length > 0) {
        const tlText = `[TIMELINES — ${timelines.length} arcs]\n${timelines.map(t => t.rendered).join("\n")}`;
        const tc = tokenCount(tlText);
        if (tc <= remaining) { parts.push(tlText); remaining -= tc; }
      }
    }
  }

  // Priority 3: emotional highlights (not in core)
  if (remaining > 100) {
    const emotional = loadEmotionalHighlights(db);
    if (emotional) {
      const tc = tokenCount(emotional);
      if (tc <= remaining) { parts.push(emotional); remaining -= tc; }
    }
  }

  // Priority 4: dailies (up to 7)
  if (remaining > 100) {
    for (const daily of loadDailies(7)) {
      if (remaining < 100) break;
      const tc = tokenCount(daily);
      if (tc <= remaining) { parts.push(daily); remaining -= tc; }
    }
  }

  // Priority 5: weekly
  if (remaining > 100) {
    const weekly = loadSummary("weekly");
    if (weekly) { const tc = tokenCount(weekly); if (tc <= remaining) { parts.push(weekly); remaining -= tc; } }
  }

  // Priority 6: quarterly
  if (remaining > 100) {
    const quarterly = loadSummary("quarterly");
    if (quarterly) { const tc = tokenCount(quarterly); if (tc <= remaining) { parts.push(quarterly); remaining -= tc; } }
  }

  return parts.join("\n\n");
}
