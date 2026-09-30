/**
 * recall-router.ts — #1877 deterministic auto-recall cue router.
 *
 * Pure function of (text, priming) deciding search vs skip for this turn.
 * No store read, no model call, synchronous and total (never throws to the
 * caller; the call site still falls back to search on throw).
 *
 * Evaluation order (binding):
 * 1. Any search cue fires → search.
 * 2. Else any listed self-contained pattern matches → skip, unless a
 *    priming term matches the current message (tie-breaker toward search).
 * 3. Else → search. Uncertainty searches; default is search.
 *
 * Cue coverage is English + Hungarian at minimum. The lists below are
 * derived from the held-out turn corpus in `recall-router.test.ts`
 * (search-required, self-contained, ambiguous cases including corrections,
 * scoped exceptions, conflicts, and action-with-constraint turns); misses
 * found during measurement are recorded there and fed back into these
 * lists, not invented from intuition.
 */

export type AutoRecallDecision = "search" | "skip";

export interface AutoRecallRouting {
  decision: AutoRecallDecision;
  /** Matched search cue or self-contained pattern name (stable for logs). */
  matched: string;
  /** Human-readable reason for the decision line. */
  reason: string;
}

// ── Search cues (any one forces search) ─────────────────────────────────────
// Each entry: stable name + case-insensitive unicode patterns.

const SEARCH_CUES: ReadonlyArray<{ name: string; patterns: RegExp[] }> = [
  {
    name: "past-reference",
    patterns: [
      /\b(remember|recall|remind|earlier|before|previous|last\s+time|yesterday|last\s+week|ago|told\s+you|you\s+said|mentioned|as\s+we|back\s+then)\b/iu,
      /(eml[eé]kszel|eml[eé]kezz|eml[eé]keztet|kor[aá]bban|tegnap|m[uú]ltkor|m[uú]lt\s+h[eé]ten|ezel[oő]tt|mondtad|eml[ií]tetted|akkor\s+mondtad)/iu,
    ],
  },
  {
    name: "correction",
    patterns: [
      /\b(actually|correction|you('re|\s+are)\s+wrong|not\s+correct|incorrect|wrong\s+answer|fix\s+that|you\s+meant|i\s+meant)\b/iu,
      /(jav[ií]ts|jav[ií]t[aá]s|t[eé]vedt[eé]l|nem\s+[uú]gy|pontos[ií]t|helyesb[ií]t[eé]s|rosszul\s+(mondtad|írtad))/iu,
    ],
  },
  {
    name: "prior-decision",
    patterns: [
      /\b(decided|decision|agreed|we\s+said|we\s+agreed|promise[sd]?|standing\s+(rule|constraint)|usual\s+way)\b/iu,
      /(d[oö]nt[oö]tt[uü]nk|d[oö]nt[eé]s|megbesz[eé]lt[uü]k|meg[aá]llapodtunk|[ií]g[eé]rted|szok[aá]sos\s+m[oó]don)/iu,
    ],
  },
  {
    name: "named-entity",
    patterns: [
      /@\w+/u,
      /\b(projects?|repos?|clients?|tickets?|issues?|colleagues?|teammates?)\b/iu,
      /(projekt\w*|[uü]gyf[eé]l\w*|ticket\w*|feladat\w*|koll[eé]g\w*)/iu,
    ],
  },
  {
    name: "action-with-constraint",
    patterns: [
      /\b(remember\s+to|don'?t\s+forget|do\s+not\s+forget|make\s+sure|always|never|remind\s+me|todo|to-?do|follow\s+the\s+usual|as\s+usual)\b/iu,
      /(ne\s+felejts|eml[eé]kezz\s+arra|mindig|soha|k[eé]rlek|biztos[ií]tsd|szok[aá]s|ahogy\s+szoktuk)/iu,
    ],
  },
  {
    name: "question-about-past",
    patterns: [
      /\b(what|which|when|where|who|how|why)\b[^.!?]*\?/iu,
      /\b(mit|melyik|mikor|hol|ki|hogyan|mi[eé]rt)\b[^.!?]*\?/iu,
    ],
  },
];

// ── Self-contained skip patterns (narrow; everything else searches) ─────────

const GREETINGS = new Set([
  "hi", "hello", "hey", "hi there", "good morning", "good evening", "good afternoon",
  "yo", "sup", "howdy",
  "szia", "sziasztok", "üdv", "üdvözlet", "helló", "hali", "szevasz",
  "jó reggelt", "jó napot", "jó estét",
]);

const ACKS = new Set([
  "thanks", "thank you", "thx", "ok", "okay", "k", "got it", "noted",
  "perfect", "great", "great thanks", "sounds good", "will do",
  "köszi", "köszönöm", "kösz", "rendben", "oké", "értettem", "értem",
  "szuper", "klassz", "jó lesz",
]);

function normalizeTurn(text: string): string {
  return text.trim().toLowerCase().replace(/[.!…]+$/u, "").replace(/\s+/gu, " ").trim();
}

/** Capitalized non-sentence-initial word: likely a name/project. */
function hasProperNounBeyondFirst(text: string): boolean {
  const tokens = text.trim().split(/\s+/u);
  if (tokens.length < 2) return false;
  for (const token of tokens.slice(1)) {
    const clean = token.replace(/^[(@"'“„]+|[.,!?;:)"'”]+$/gu, "");
    if (/^[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]{2,}$/u.test(clean)) return true;
  }
  return false;
}

function isUltraShortSelfContained(normalized: string): boolean {
  if (normalized.includes("?")) return false;
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  if (tokens.length > 2) return false;
  if (normalized.length > 20) return false;
  if (!/^[a-záéíóöőúüű0-9\s!,.-]+$/iu.test(normalized)) return false;
  return true;
}

function primingMatchesCurrent(text: string, priming: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const raw of priming) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().toLowerCase();
    if (term.length < 3) continue;
    if (lower.includes(term)) return raw.trim();
  }
  return undefined;
}

/**
 * Decide search vs skip for one turn. Pure and synchronous.
 * Never throws: internal failures fall back to search.
 */
export function shouldAutoRecall(text: string, priming: readonly string[]): AutoRecallRouting {
  try {
    const input = typeof text === "string" ? text : "";
    const normalized = normalizeTurn(input);

    for (const cue of SEARCH_CUES) {
      for (const pattern of cue.patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(input)) {
          return { decision: "search", matched: cue.name, reason: `search-cue:${cue.name}` };
        }
      }
    }
    if (hasProperNounBeyondFirst(input)) {
      return { decision: "search", matched: "named-entity", reason: "search-cue:named-entity(proper-noun)" };
    }

    if (GREETINGS.has(normalized)) {
      const tie = primingMatchesCurrent(input, priming);
      if (tie !== undefined) {
        return { decision: "search", matched: "priming-term-match", reason: `tie-breaker:priming-term("${tie}")` };
      }
      return { decision: "skip", matched: "greeting", reason: "self-contained:greeting" };
    }
    if (ACKS.has(normalized)) {
      const tie = primingMatchesCurrent(input, priming);
      if (tie !== undefined) {
        return { decision: "search", matched: "priming-term-match", reason: `tie-breaker:priming-term("${tie}")` };
      }
      return { decision: "skip", matched: "acknowledgement", reason: "self-contained:acknowledgement" };
    }
    if (normalized && isUltraShortSelfContained(normalized)) {
      const tie = primingMatchesCurrent(input, priming);
      if (tie !== undefined) {
        return { decision: "search", matched: "priming-term-match", reason: `tie-breaker:priming-term("${tie}")` };
      }
      return { decision: "skip", matched: "ultra-short", reason: "self-contained:ultra-short" };
    }

    return { decision: "search", matched: "default", reason: "default:search" };
  } catch {
    return { decision: "search", matched: "error-fallback", reason: "fallback:search-on-error" };
  }
}
