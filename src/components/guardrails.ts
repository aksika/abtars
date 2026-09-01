/**
 * guardrails.ts — path + command restrictions for SECURITY_MODE=guardrails.
 * Defense-in-depth: catches accidental/confused model behavior, NOT adversarial bypass.
 */

import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getEnv } from "./env-schema.js";
import { logWarn } from "./logger.js";

const TAG = "guardrails";
const HOME = homedir();

const BLOCKED_PATHS = [
  `${HOME}/.ssh${sep}`,
  `${HOME}/.abtars/secret${sep}`,
  `/etc${sep}`,
  `/proc${sep}`,
  `/sys${sep}`,
  `/dev${sep}`,
  `/root${sep}`,
  `/run${sep}`,
];

const WRITE_BLOCKED = [
  `${HOME}/.abtars/config/peers.json`,
  `${HOME}/.kiro${sep}`,
];

const BLOCKED_COMMAND_PREFIXES = [
  "rm -rf /",
];

const AUTH_REQUIRED_PATTERNS = [
  /\brm\s+(-[a-z]*f[a-z]*r|-[a-z]*r[a-z]*f)\b/i,
  /\bgit\s+(reset\s+--hard|push\s+--force|clean\s+-f|branch\s+-D)/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s/i,
  /\bkill\s+(-9|--signal\s+(KILL|9))/i,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bDELETE\s+FROM\s+\w+\s*;/i,
];

const SQL_DANGEROUS = [
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\s+\w+/i,
];

export type CommandTier = "block" | "auth-required" | "allow";

// Bounded recursion for nested evaluation inspection
const MAX_NESTED_DEPTH = 3;
const MAX_NESTED_BYTES = 8192;

/** Classify a command into block / auth-required / allow. Payload-aware per #1752. */
export function classifyCommand(cmd: string): CommandTier {
  return classifyInternal(cmd, 0, MAX_NESTED_BYTES);
}

function classifyInternal(cmd: string, depth: number, remainingBytes: number): CommandTier {
  if (depth > MAX_NESTED_DEPTH || remainingBytes <= 0) return "auth-required";
  const trimmed = cmd.trim();
  if (!trimmed) return "allow";

  // 1. Blocked prefixes — checked on raw trimmed before any stripping (defense in depth)
  for (const prefix of BLOCKED_COMMAND_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return "block";
  }

  // 2. source / . — executed file content is outside command string, cannot be inspected
  if (/^\s*(source|\.)\s+/.test(trimmed)) return "auth-required";

  // 3. SQL interpreter payload inspection — treat SQL payload as executable, not safe file content
  //    Must inspect before heredoc stripping for non-SQL case
  const hasSqlInterpreter = /\b(sqlite3|psql|mysql)\b/i.test(trimmed);
  if (hasSqlInterpreter) {
    // Inspect raw trimmed (including heredoc bodies and quoted strings) for destructive SQL
    for (const re of SQL_DANGEROUS) {
      if (re.test(trimmed)) return "auth-required";
    }
    // Also inspect extracted heredoc bodies explicitly (in case raw scan missed due to newlines)
    const bodies = extractHeredocBodies(trimmed);
    for (const body of bodies) {
      for (const re of SQL_DANGEROUS) {
        if (re.test(body)) return "auth-required";
      }
    }
  }

  // 4. Nested evaluation — recursively inspect bash -c, sh -c, eval, command substitutions
  const nested = extractNestedPayloads(trimmed);
  for (const payload of nested) {
    if (payload.length === 0) continue;
    // Bounded recursion with byte budget
    const tier = classifyInternal(payload, depth + 1, remainingBytes - payload.length);
    if (tier === "block") return "block";
    if (tier === "auth-required") return "auth-required";
  }
  // If nested evaluation was detected but payload extraction failed (ambiguous/unclosed), fail closed
  if (hasAmbiguousNestedEvaluation(trimmed, nested)) {
    return "auth-required";
  }

  // 5. Build executable surface: strip heredoc bodies (for non-SQL) and quoted strings
  let surface = trimmed;
  if (!hasSqlInterpreter) {
    surface = stripHeredocBodies(surface);
  }
  // Remove quoted strings to prevent prose/data from reclassifying the command
  // For SQL interpreters we already handled SQL dangerous above; generic dangerous patterns on surface still use stripped version
  if (!hasSqlInterpreter) {
    surface = stripQuotedStrings(surface);
  } else {
    // For SQL, keep raw for generic checks? But generic check after SQL should still use stripped quotes? We keep stripped for generic to avoid false positives from quoted sudo in SQL prose? Actually SQL prose is executable, so we keep as is for SQL case? Simpler: for SQL, don't strip quotes for generic check either
    // Do not strip quoted strings when SQL interpreter present — SQL payload is already considered executable
  }

  // 6. Scan generic dangerous patterns on the executable surface
  // For SQL case, surface is still raw trimmed; for non-SQL, it's stripped
  for (const re of AUTH_REQUIRED_PATTERNS) {
    if (re.test(surface)) return "auth-required";
  }
  return "allow";
}

function hasAmbiguousNestedEvaluation(cmd: string, extracted: string[]): boolean {
  // If cmd contains bash -c / sh -c / eval / $( but we extracted no payload, it's ambiguous -> fail closed
  if (/\b(bash|sh)\s+.*-c\b/.test(cmd) && extracted.length === 0) {
    // Check if there's a -c without successful quote extraction
    // Look for bash/sh -c without a matching quoted payload
    if (/\b(bash|sh)\s+.*-c\s+/.test(cmd)) return true;
  }
  if (/\beval\s+/.test(cmd) && extracted.length === 0) {
    // eval without extracted payload but present in cmd
    // Only ambiguous if eval is followed by something we couldn't extract
    const afterEval = cmd.split(/\beval\s+/)[1];
    if (afterEval && afterEval.trim().length > 0) return true;
  }
  return false;
}

function extractNestedPayloads(cmd: string): string[] {
  const payloads: string[] = [];
  // bash -c / sh -c with quoted payload (single or double quotes)
  const bashCQuoted = /\b(bash|sh)\s+(?:[^\n]*?\s)?-c\s+(["'])(.*?)\2/gs;
  let m: RegExpExecArray | null;
  while ((m = bashCQuoted.exec(cmd)) !== null) {
    if (m[3] !== undefined) payloads.push(m[3]);
  }
  // bash -c with unquoted payload up to next command separator (;, |, &, newline)
  // Only if no quoted version was found for that occurrence; we re-scan for unquoted
  // Use a separate regex that captures unquoted token after -c when not quoted
  const bashCUnquoted = /\b(bash|sh)\s+(?:[^\n]*?\s)?-c\s+([^\s"'`$;|&]+)/g;
  while ((m = bashCUnquoted.exec(cmd)) !== null) {
    // Avoid duplicating already captured quoted payloads — check if this match was part of a quoted one
    const full = m[0];
    if (full.includes('"') || full.includes("'")) continue;
    if (m[2]) payloads.push(m[2]);
  }
  // eval with quoted payload
  const evalQuoted = /\beval\s+(["'])(.*?)\1/gs;
  while ((m = evalQuoted.exec(cmd)) !== null) {
    if (m[2] !== undefined) payloads.push(m[2]);
  }
  // eval with unquoted remainder (capture up to ; or end)
  // Only if eval not already captured as quoted
  if (!/\beval\s+["']/.test(cmd) && /\beval\s+/.test(cmd)) {
    const evalUnquotedMatch = cmd.match(/\beval\s+([^\n;|&]+)/);
    if (evalUnquotedMatch && evalUnquotedMatch[1]) {
      const payload = evalUnquotedMatch[1].trim();
      if (payload && !payloads.includes(payload)) payloads.push(payload);
    }
  }
  // Command substitution $(...) — handle nested parens with simple non-greedy; bounded depth will re-inspect inner
  const dollarParen = /\$\(([^)]+)\)/g;
  while ((m = dollarParen.exec(cmd)) !== null) {
    if (m[1]) payloads.push(m[1]);
  }
  // Backtick `...`
  const backtick = /`([^`]+)`/g;
  while ((m = backtick.exec(cmd)) !== null) {
    if (m[1]) payloads.push(m[1]);
  }
  return payloads;
}

function stripQuotedStrings(s: string): string {
  // Replace single-quoted '...' (including escaped) and double-quoted "..." with spaces
  // Also handle backticks (already handled as nested, but strip for surface)
  let result = s;
  // single quotes
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, ' ');
  // double quotes
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  return result;
}

function stripHeredocBodies(cmd: string): string {
  const lines = cmd.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    result.push(line);
    const heredocMatch = line.match(/<<-?\s*'?([^'"\s]+)'?/);
    if (heredocMatch && heredocMatch[1]) {
      const delimiter = heredocMatch[1];
      // Skip body lines until delimiter line found
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        // For <<- indented heredoc, delimiter may be preceded by tabs
        const stripped = bodyLine.replace(/^\t+/, '').trim();
        if (stripped === delimiter) {
          // Include delimiter line? Not needed for surface, but include to preserve structure
          result.push(bodyLine);
          break;
        }
        // Body line is discarded (not pushed to result)
        i++;
      }
    }
    i++;
  }
  return result.join("\n");
}

function extractHeredocBodies(cmd: string): string[] {
  const bodies: string[] = [];
  const lines = cmd.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const heredocMatch = line.match(/<<-?\s*'?([^'"\s]+)'?/);
    if (heredocMatch && heredocMatch[1]) {
      const delimiter = heredocMatch[1];
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        const stripped = bodyLine.replace(/^\t+/, '').trim();
        if (stripped === delimiter) break;
        bodyLines.push(bodyLine);
        i++;
      }
      if (bodyLines.length > 0) bodies.push(bodyLines.join("\n"));
    }
    i++;
  }
  return bodies;
}

export type SecurityMode = "off" | "guardrails" | "seatbelt" | "docker";

export function getSecurityMode(): SecurityMode {
  const mode = getEnv().securityMode as SecurityMode;
  return mode || "off";
}

export function isGuardrailsActive(): boolean {
  return getSecurityMode() !== "off";
}

export function isSeatbeltActive(): boolean {
  const m = getSecurityMode();
  return m === "seatbelt" || m === "docker";
}

export function isDockerActive(): boolean {
  return getSecurityMode() === "docker";
}

/** Check if a file path is allowed. Returns error message or null if OK. */
export function checkPath(path: string, mode: "read" | "write"): string | null {
  if (!isGuardrailsActive()) return null;

  const resolved = resolve(path) + (path.endsWith("/") ? sep : "");

  for (const blocked of BLOCKED_PATHS) {
    if (resolved.startsWith(blocked) || resolved === blocked.slice(0, -1)) {
      return `Path blocked by guardrails: ${path}`;
    }
  }

  if (mode === "write") {
    for (const wb of WRITE_BLOCKED) {
      if (resolved.startsWith(wb) || resolved === wb) {
        return `Write blocked by guardrails: ${path}`;
      }
    }
  }

  return null;
}

/** Check if a bash command is allowed. Returns error message or null if OK. */
export function checkCommand(cmd: string): string | null {
  if (!isGuardrailsActive()) return null;

  const tier = classifyCommand(cmd);
  if (tier === "block") {
    logWarn(TAG, `Blocked command: ${cmd.slice(0, 100)}`);
    return `Command blocked by guardrails: ${cmd.slice(0, 60)}`;
  }
  // "auth-required" is handled by action-gate at a higher level — not blocked here
  return null;
}
