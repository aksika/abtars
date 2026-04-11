/**
 * brain-patterns.ts — Brain-inspired memory enhancements.
 * Pure functions used by recall, store, and sleep steps.
 */

/** E1: Flashbulb protection — is this memory protected from decay/aging? */
export function isFlashbulb(emotionScore: number, importanceFlags: string): boolean {
  if (Math.abs(emotionScore) < 4) return false;
  return importanceFlags.includes("pivot") || importanceFlags.includes("correction");
}

/** E1: Is this memory protected from aging (broader than flashbulb)? */
export function isAgingProtected(emotionScore: number, recallCount: number, tier: string): boolean {
  if (Math.abs(emotionScore) >= 4) return true;
  if (recallCount >= 3) return true;
  if (tier === "core") return true;
  return false;
}

/**
 * E2: Spaced repetition decay — compute effective confidence.
 * Confidence decays over time unless the memory is recalled at intervals.
 */
export function effectiveConfidence(
  baseConfidence: number,
  daysSinceLastRecall: number,
  recallCount: number,
): number {
  if (recallCount === 0) {
    // Never recalled: decay faster
    const decay = Math.max(0, 1 - daysSinceLastRecall / 90);
    return Math.round(baseConfidence * decay * 10) / 10;
  }
  // Recalled: decay slower based on recall frequency
  const stability = Math.min(1, Math.log2(recallCount + 1) / 3);
  const decay = Math.max(0, 1 - (daysSinceLastRecall / (90 + stability * 270)));
  return Math.round(baseConfidence * decay * 10) / 10;
}

/**
 * E6: Interference detection — check if two memories might cause confusion.
 * Same topic, high keyword overlap, but different content.
 */
export function detectInterference(
  contentA: string,
  contentB: string,
  topicA: string,
  topicB: string,
): boolean {
  if (topicA !== topicB) return false;

  const wordsA = new Set(contentA.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const wordsB = new Set(contentB.toLowerCase().match(/[a-z]{3,}/g) ?? []);

  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;

  const overlapRatio = overlap / Math.min(wordsA.size, wordsB.size);

  // High overlap (>60%) but not identical = potential interference
  return overlapRatio > 0.6 && contentA !== contentB;
}
