/**
 * memory-compressor.ts — ABM-L compression.
 * Converts English memory text + metadata into compact ABM-L format.
 * Pure function, ~1-5ms per call.
 */

// import type { EmotionTag } from "./emotion-tagger.js";
import type { ImportanceFlag } from "./importance-flagger.js";

const FLAG_MAP: Record<ImportanceFlag, string> = {
  decision: "D", origin: "O", core_belief: "B", pivot: "V",
  technical: "T", correction: "C", preference: "P", milestone: "M",
};

const FILLER = /\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|shall|can|basically|essentially|actually|really|very|just|quite|rather|simply|that|this|these|those|it|its|we|our|i|my|me|you|your|also|so|then|well)\b/gi;
const MULTI_SPACE = /\s{2,}/g;

/** Known entity patterns — auto-detected from text. */
function detectEntities(text: string): Map<string, string> {
  const entities = new Map<string, string>();
  // Capitalized multi-word names (2+ words starting with uppercase)
  const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  for (const name of properNouns) {
    const ref = "@" + name.toLowerCase().replace(/\s+/g, "-");
    entities.set(name, ref);
  }
  // Single capitalized words that look like tool/project names (not sentence-start)
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!.replace(/[^a-zA-Z0-9]/g, "");
    if (w.length >= 2 && /^[A-Z][a-z]/.test(w) && !isCommonWord(w)) {
      entities.set(w, "@" + w.toLowerCase());
    }
  }
  return entities;
}

const COMMON_WORDS = new Set([
  "the", "this", "that", "these", "those", "here", "there", "when", "where",
  "what", "which", "who", "how", "why", "because", "since", "after", "before",
  "during", "between", "about", "into", "through", "also", "just", "very",
  "really", "still", "even", "only", "much", "many", "some", "any", "every",
  "each", "both", "few", "more", "most", "other", "same", "such", "than",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December", "Today", "Yesterday", "Tomorrow",
  "However", "Therefore", "Furthermore", "Moreover", "Although", "Meanwhile",
  "Instead", "Otherwise", "Finally", "First", "Second", "Third", "Next", "Last",
]);

function isCommonWord(w: string): boolean {
  return COMMON_WORDS.has(w);
}

/** Detect relationship operators in text. */
function applyRelationships(text: string): string {
  return text
    .replace(/\binstead of\b/gi, ">over")
    .replace(/\breplaces?\b/gi, ">replaces")
    .replace(/\bcauses?\b/gi, ">causes")
    .replace(/\bblocks?\b/gi, ">blocks")
    .replace(/\bleads? to\b/gi, "→")
    .replace(/\bbecomes?\b/gi, "→")
    .replace(/\bbecause\b/gi, "∵");
}

/** Strip filler words and compress whitespace. */
function stripFiller(text: string): string {
  return text.replace(FILLER, "").replace(MULTI_SPACE, " ").trim();
}

/** Preserve technical tokens (paths, URLs, commands). */
function preserveTechnical(text: string): { preserved: Map<string, string>; cleaned: string } {
  const preserved = new Map<string, string>();
  let idx = 0;
  const cleaned = text.replace(/(?:\/[\w./-]+|~\/[\w./-]+|https?:\/\/\S+|`[^`]+`)/g, (match) => {
    const key = `__TECH${idx++}__`;
    preserved.set(key, match);
    return key;
  });
  return { preserved, cleaned };
}

/** Restore preserved technical tokens. */
function restoreTechnical(text: string, preserved: Map<string, string>): string {
  let result = text;
  for (const [key, value] of preserved) {
    result = result.replace(key, value);
  }
  return result;
}

export interface CompressInput {
  content_en: string;
  topic: string;
  emotion_tags: string;
  importance_flags: string;
  confidence?: number;
  date?: string;
}

/**
 * Compress a memory into ABM-L format.
 * Example output: [D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
 */
export function compress(input: CompressInput): string {
  const { content_en, topic, emotion_tags, importance_flags, confidence, date } = input;

  // Build prefix
  const flags = importance_flags
    .split(",").filter(Boolean)
    .map(f => FLAG_MAP[f.trim() as ImportanceFlag] ?? "").join("");
  const emotionShort = emotion_tags.split(",")[0]?.trim().slice(0, 6) ?? "—";
  const conf = confidence ?? 3;
  const dateStr = date ?? new Date().toISOString().slice(0, 7);
  const prefix = `[${flags || "F"}|${topic}|${emotionShort}|${conf}|${dateStr}]`;

  // Compress content
  const { preserved, cleaned } = preserveTechnical(content_en);
  const entities = detectEntities(cleaned);

  let body = cleaned;
  // Apply entity references (longest first to avoid partial matches)
  const sorted = [...entities.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, ref] of sorted) {
    body = body.replace(new RegExp(`\\b${name}\\b`, "g"), ref);
  }

  body = applyRelationships(body);
  body = stripFiller(body);
  body = restoreTechnical(body, preserved);

  // Collapse parenthetical reasons
  body = body.replace(/\s*∵\s*(.{3,60}?)(?:\.|$)/g, " ($1)");

  // Clean up
  body = body.replace(MULTI_SPACE, " ").replace(/\s+([.,;:!?])/g, "$1").trim();

  // Truncate if too long (ABM-L should be concise)
  if (body.length > 120) body = body.slice(0, 117) + "...";

  return `${prefix} ${body}`;
}
