/**
 * sanitize-outbound.ts — Strip internal tags before delivering to user.
 */
const STRIP = [
  /\s*\[TOPICS:\s*.+?\]/gi,
  /\s*\[NO_REPLY\]\s*/gi,
  /\s*\[REACT:.+?\]\s*/gi,
];

export function sanitizeOutbound(text: string): string {
  let out = text;
  for (const re of STRIP) { re.lastIndex = 0; out = out.replace(re, ""); }
  return out.trim();
}
