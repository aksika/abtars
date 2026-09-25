/**
 * a2a-guardrails.ts — the incoming A2A guardrail whitelist (#1854).
 *
 * One operator-owned file bounds everything a peer-originated execution may
 * touch on this host: `~/.abtars/config/a2a-guardrails.json` with three
 * sections — R (read paths), W (write paths), X (execute scope). A section
 * containing `"*"` allows everything in that section.
 *
 * Two invariants make this a guardrail rather than a suggestion:
 *
 * - It is GLOBAL and the only source of A2A path scope. peers.json carries
 *   per-peer `trust`, which decides which sections a peer may use at all; it
 *   carries no paths of its own, so there is one place to read and one place
 *   to edit.
 * - Every failure resolves to the shipped defaults, never to `"*"`. A missing,
 *   unreadable, malformed, or partially invalid file yields
 *   `~/.abtars/workspace/projects/*` (the per-card workspace layout from
 *   #1844) and warns. Absence of configuration never widens access.
 *
 * A2A decisions are configuration, not conversation: an incoming request is
 * allowed or denied from this file. It never reaches the ActionGate Telegram
 * prompt, which exists for the interactive owner and would otherwise let a
 * remote peer page the master (the #1854 defect).
 *
 * The whitelist applies independently of SECURITY_MODE, matching the existing
 * rule that session policy is never widened by `SECURITY_MODE=off`.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { abtarsHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";
import { loadPeerConfig } from "./peer-config.js";

const TAG = "a2a-guardrails";

/** Section vocabulary: read paths, write paths, execute scope. */
export type A2ASection = "R" | "W" | "X";

/** A resolved section: every path, or a list of canonical path prefixes. */
export type A2AScope = "*" | readonly string[];

export interface A2AWhitelist {
  readonly R: A2AScope;
  readonly W: A2AScope;
  readonly X: A2AScope;
}

/**
 * Shipped default for all three sections, written operator-facing as
 * `~/.abtars/workspace/projects/*`: the per-card project workspace root
 * (#1844 layout) and nothing else. An unconfigured host lets a peer work
 * inside the workspace bound to its own project and nowhere else. Resolved
 * through abtarsHome() per call so ABTARS_HOME overrides and hermetic tests
 * work, never a hardcoded homedir().
 */
export const A2A_DEFAULT_SCOPE_DISPLAY = "~/.abtars/workspace/projects/*";

function defaultScopeRoot(): string {
  return join(abtarsHome(), "workspace", "projects");
}

export function a2aWhitelistPath(): string {
  return join(abtarsHome(), "config", "a2a-guardrails.json");
}

function defaultWhitelist(): A2AWhitelist {
  const scope = [defaultScopeRoot()];
  return { R: scope, W: scope, X: scope };
}

/**
 * Canonicalize one configured entry to a comparable absolute prefix. `~`
 * expands, a trailing `/*`, `/**` or `*` becomes a prefix, and the result is
 * resolved. Returns null for a non-string or empty entry so one bad line
 * cannot silently become the filesystem root.
 */
function normalizeEntry(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  let value = entry.trim();
  if (!value) return null;
  if (value === "*") return "*";
  value = value.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\*$/, "");
  if (!value) return null;
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
  const resolved = resolve(expanded);
  return resolved === sep ? null : resolved;
}

/** Parse one section. A `"*"` entry wins; invalid entries are dropped. */
function parseSection(raw: unknown, section: A2ASection): A2AScope | null {
  if (!Array.isArray(raw)) return null;
  const prefixes: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeEntry(entry);
    if (normalized === null) {
      logWarn(TAG, `Ignored an invalid ${section} entry in ${a2aWhitelistPath()}`);
      continue;
    }
    if (normalized === "*") return "*";
    prefixes.push(normalized);
  }
  return prefixes;
}

interface CachedWhitelist {
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: A2AWhitelist;
}

let cache: CachedWhitelist | null = null;

/**
 * Load the whitelist, re-reading when the file changes so an operator edit is
 * honored without a restart (same contract as the ActionGate rules file). Any
 * failure returns the defaults.
 */
export function loadA2AWhitelist(): A2AWhitelist {
  const path = a2aWhitelistPath();
  if (!existsSync(path)) {
    cache = null;
    return defaultWhitelist();
  }
  try {
    const stat = statSync(path);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const fallback = defaultWhitelist();
    const value: A2AWhitelist = {
      R: parseSection(parsed["R"], "R") ?? fallback.R,
      W: parseSection(parsed["W"], "W") ?? fallback.W,
      X: parseSection(parsed["X"], "X") ?? fallback.X,
    };
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch (err) {
    logWarn(TAG, `${path} is unreadable or malformed — applying defaults: ${err instanceof Error ? err.message : String(err)}`);
    cache = null;
    return defaultWhitelist();
  }
}

/** Test seam: drop the mtime cache. */
export function resetA2AWhitelistCache(): void {
  cache = null;
}

// ── Trust bounding ──────────────────────────────────────────────────────────

/**
 * Which sections a trust level may use at all. peers.json documents trust as
 * 0 unknown / 1 enrolled / 2 trusted / >=3 owner. An unknown peer and an
 * unenrolled peer get nothing; an enrolled peer may read; write and execute
 * need an explicitly trusted peer.
 */
function sectionsForTrust(trust: number): ReadonlySet<A2ASection> {
  if (trust >= 2) return new Set<A2ASection>(["R", "W", "X"]);
  if (trust >= 1) return new Set<A2ASection>(["R"]);
  return new Set<A2ASection>();
}

export interface A2ACapabilities {
  readonly peer: string | null;
  readonly trust: number;
  readonly read: A2AScope;
  readonly write: A2AScope;
  readonly exec: A2AScope;
}

const DENY_ALL: A2ACapabilities = { peer: null, trust: 0, read: [], write: [], exec: [] };

/**
 * Resolve what one peer-originated execution may do. Paths come only from the
 * global whitelist; the peer's `trust` level decides which sections apply.
 * An unresolvable peer identity denies everything (fail closed).
 *
 * #1854: per-peer path lists were deliberately removed from peers.json. The
 * read/write/execute scope is a host-global guardrail, not a per-peer
 * negotiation, so there is exactly one place to read and one place to edit.
 */
export function resolveA2ACapabilities(sourcePeer: string | null): A2ACapabilities {
  if (!sourcePeer) return DENY_ALL;
  let trust = 0;
  try {
    const entry = loadPeerConfig().peers[sourcePeer];
    if (!entry) return { ...DENY_ALL, peer: sourcePeer };
    trust = typeof entry.trust === "number" ? entry.trust : 0;
  } catch (err) {
    logWarn(TAG, `Peer config unreadable — denying A2A access for ${sourcePeer}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DENY_ALL, peer: sourcePeer };
  }

  const sections = sectionsForTrust(trust);
  const whitelist = loadA2AWhitelist();
  return {
    peer: sourcePeer,
    trust,
    read: sections.has("R") ? whitelist.R : [],
    write: sections.has("W") ? whitelist.W : [],
    exec: sections.has("X") ? whitelist.X : [],
  };
}

// ── Matching ────────────────────────────────────────────────────────────────

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || (root === sep ? candidate.startsWith(sep) : candidate.startsWith(root + sep));
}

/**
 * Match a candidate path against a scope using both the lexical and the
 * realpath form: /etc, /tmp and /var are symlinks on macOS, and a
 * realpath-only test would also miss a not-yet-created write target.
 */
export function scopeAllows(scope: A2AScope, filePath: string): boolean {
  if (scope === "*") return true;
  if (scope.length === 0) return false;
  const expanded = filePath.startsWith("~") ? join(homedir(), filePath.slice(1)) : filePath;
  const normalized = resolve(expanded);
  let real: string;
  try { real = realpathSync(normalized); } catch { real = normalized; }
  return scope.some((root) => isUnder(normalized, root) || isUnder(real, root));
}

/** True when this execution's working directory is inside the X scope. */
export function execScopeAllows(caps: A2ACapabilities, cwd: string | undefined): boolean {
  if (caps.exec === "*") return true;
  if (caps.exec.length === 0) return false;
  if (!cwd) return false;
  return scopeAllows(caps.exec, cwd);
}

/** One-line operator-facing summary for boot logging and diagnostics. */
export function describeA2AWhitelist(): string {
  const w = loadA2AWhitelist();
  const render = (scope: A2AScope): string => (scope === "*" ? "*" : scope.length === 0 ? "(none)" : `${scope.length} path(s)`);
  const source = existsSync(a2aWhitelistPath()) ? a2aWhitelistPath() : "defaults";
  return `A2A guardrails (${source}): R=${render(w.R)} W=${render(w.W)} X=${render(w.X)}`;
}

/** Log the effective whitelist once at boot so the operator sees the ceiling. */
export function logA2AWhitelist(): void {
  logInfo(TAG, describeA2AWhitelist());
}
