/**
 * sanitize-outbound.ts — Strip internal tags before delivering to user.
 */
import { SUPPORT_STRIP_RE } from "./clean-response.js";

const STRIP = [
  /\s*\[TOPICS:\s*.+?\]/gi,
  /\s*\[NO_REPLY\]\s*/gi,
  /\s*\[REACT:.+?\]\s*/gi,
  SUPPORT_STRIP_RE,
];

export function sanitizeOutbound(text: string): string {
  let out = text;
  for (const re of STRIP) { re.lastIndex = 0; out = out.replace(re, ""); }
  return out.trim();
}
