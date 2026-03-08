/** Clamp a value to [-5, +5]. Non-integer or missing values default to 0. */
export function clampEmotionScore(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-5, Math.min(5, n));
}
