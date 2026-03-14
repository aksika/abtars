/**
 * Lightweight regex-based prompt injection scanner for A2A messages.
 * Inspired by Hermes memory_tool.py — ~12 patterns + invisible unicode.
 * Zero latency (compiled regexes, no LLM).
 */

export interface ScanHit {
  patternId: string;
  matched: string;
}

const THREAT_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, "prompt_injection"],
  [/you\s+are\s+(?:\w+\s+)*now\s+/i, "role_hijack"],
  [/do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(?:\w+\s+)*(?:your|all|any)\s+(?:\w+\s+)*(?:instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(?:if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(?:have\s+no|don't\s+have)\s+(?:\w+\s+)*(?:restrictions|limits|rules)/i, "bypass_restrictions"],
  [/curl\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc)/i, "read_secrets"],
  [/rm\s+-rf\s+\//i, "destructive_root_rm"],
  [/authorized_keys/i, "ssh_backdoor"],
  [/(?:\/etc\/sudoers|visudo)/i, "sudoers_mod"],
];

const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
]);

export function scanPrompt(text: string): ScanHit | null {
  for (const char of text) {
    if (INVISIBLE_CHARS.has(char)) {
      return { patternId: "invisible_unicode", matched: `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` };
    }
  }
  for (const [re, id] of THREAT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      return { patternId: id, matched: m[0].slice(0, 60) };
    }
  }
  return null;
}
