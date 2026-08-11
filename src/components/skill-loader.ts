/**
 * skill-loader.ts — Strict interactive-skill loading (#1432).
 *
 * Replaces permissive skill.json casts and shell-interpolated prerequisite
 * checks. All resolved skill and context paths must remain under approved
 * abtars roots after normalization; `..`, absolute injection, and symlink
 * escape fail closed. Prerequisites are checked as data through a
 * shell-free process API.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentName } from "./subagent-runtime.js";
import { abtarsHome, abtarsRoot } from "../paths.js";
import { logInfo } from "./logger.js";

const TAG = "skill-loader";

export const SKILL_IDENTIFIER_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
export const SKILL_CONTEXT_MAX_CHARS = 30_000;

export interface SkillConfigV1 {
  agent?: AgentName;
  interactive: true;
  contextPath?: string;
  description?: string;
  tools?: string[];
  timeout: number;
  prerequisites?: string[];
}

export interface ResolvedSkill {
  name: string;
  dir: string;
  config: SkillConfigV1;
  skillMd: string;
  /** Absolute resolved context path (may not exist yet — created on demand). */
  contextPath?: string;
  /** Context content, bounded to SKILL_CONTEXT_MAX_CHARS. */
  context?: string;
}

export type SkillLoadErrorCode =
  | "invalid_identifier"
  | "not_found"
  | "malformed_config"
  | "not_interactive"
  | "missing_skill_md"
  | "invalid_context_path"
  | "missing_prerequisite";

export interface SkillLoadError {
  code: SkillLoadErrorCode;
  message: string;
}

export type SkillLoadResult =
  | { ok: true; skill: ResolvedSkill }
  | { ok: false; error: SkillLoadError };

const SKILL_SUBDIRS = ["self", "custom", "downloaded", "core"];
const AGENT_NAMES: readonly AgentName[] = ["professor", "dreamy", "browsie", "coding", "task"];

/** Ordered skill roots: ~/.abtars/skills/{self,custom,downloaded,core} then the bundle. */
export function skillRoots(): string[] {
  const base = join(abtarsHome(), "skills");
  return [
    ...SKILL_SUBDIRS.map(sub => join(base, sub)),
    join(abtarsHome(), "app", "bundle", "core", "skills"),
  ];
}

/** Resolve a skill directory by name through the ordered roots. */
export function resolveSkillDir(name: string): string | null {
  if (!SKILL_IDENTIFIER_RE.test(name)) return null;
  for (const root of skillRoots()) {
    // Resolve both the directory and its manifest through the real filesystem
    // path. A symlinked skill must not make the loader read code/configuration
    // from outside the approved skill root.
    const rootReal = safeRealpath(root);
    if (!rootReal) continue;
    const dir = normalizeUnderRoot(join(rootReal, name), rootReal);
    if (!dir) continue;
    const manifest = normalizeUnderRoot(join(dir, "skill.json"), rootReal);
    if (manifest && existsSync(manifest)) return dir;
  }
  return null;
}

/**
 * Realpath of the deepest existing ancestor, with the remaining lexical
 * suffix appended. Catches mid-path symlink escape even when the leaf file
 * does not exist yet.
 */
export function realpathExisting(path: string): string | null {
  let current = path;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    let real = realpathSync(current);
    for (const part of suffix) real = join(real, part);
    return real;
  } catch { return null; }
}

/**
 * Normalize an arbitrary candidate path against an approved real root.
 * Fails closed on `..` escape, absolute injection outside the root, and
 * symlink escape (realpath containment when the file exists).
 */
export function normalizeUnderRoot(candidate: string, root: string): string | null {
  const rootReal = safeRealpath(root);
  if (!rootReal) return null;
  const abs = isAbsolute(candidate) ? candidate : join(rootReal, candidate);
  const normalized = resolve(abs);
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (normalized !== rootReal && !normalized.startsWith(rootPrefix)) return null;
  if (normalized.includes(".." + sep)) return null;
  const resolvedReal = realpathExisting(normalized);
  if (!resolvedReal) return null;
  const realPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (resolvedReal !== rootReal && !resolvedReal.startsWith(realPrefix)) return null;
  return resolvedReal;
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** Context candidate under an approved root, with `${userId}` substitution. */
export function resolveContextPath(config: SkillConfigV1, userId: string): string | null {
  if (!config.contextPath) return null;
  const candidate = config.contextPath.replaceAll("${userId}", userId);
  return normalizeUnderRoot(candidate, abtarsHome());
}

/** Structured parse of skill.json — permissive casts are gone. */
export function parseSkillConfig(raw: string): { ok: true; config: SkillConfigV1 } | { ok: false; error: SkillLoadError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "malformed_config", message: "skill.json is not valid JSON" } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { code: "malformed_config", message: "skill.json must be an object" } };
  }
  const e = parsed as Record<string, unknown>;
  if (e["interactive"] !== true) {
    return { ok: false, error: { code: "not_interactive", message: 'skill.json interactive must be true for an interactive skill' } };
  }
  const timeout = e["timeout"];
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
    return { ok: false, error: { code: "malformed_config", message: "skill.json timeout must be a positive integer number of seconds" } };
  }
  const agent = e["agent"];
  if (agent !== undefined && (typeof agent !== "string" || !AGENT_NAMES.includes(agent as AgentName))) {
    return { ok: false, error: { code: "malformed_config", message: `skill.json agent must be one of: ${AGENT_NAMES.join(", ")}` } };
  }
  const contextPath = e["contextPath"];
  if (contextPath !== undefined && (typeof contextPath !== "string" || !contextPath.trim())) {
    return { ok: false, error: { code: "malformed_config", message: "skill.json contextPath must be a string" } };
  }
  const description = e["description"];
  if (description !== undefined && typeof description !== "string") {
    return { ok: false, error: { code: "malformed_config", message: "skill.json description must be a string" } };
  }
  const tools = e["tools"];
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(t => typeof t !== "string"))) {
    return { ok: false, error: { code: "malformed_config", message: "skill.json tools must be an array of strings" } };
  }
  const prerequisites = e["prerequisites"];
  if (prerequisites !== undefined && (!Array.isArray(prerequisites) || prerequisites.some(p => typeof p !== "string" || !p.trim()))) {
    return { ok: false, error: { code: "malformed_config", message: "skill.json prerequisites must be an array of binary names" } };
  }
  return {
    ok: true,
    config: {
      agent: agent as AgentName | undefined,
      interactive: true,
      contextPath: (contextPath as string | undefined)?.trim() || undefined,
      description: (description as string | undefined)?.trim() || undefined,
      tools: (tools as string[] | undefined) ?? undefined,
      timeout,
      prerequisites: (prerequisites as string[] | undefined) ?? undefined,
    },
  };
}

/** Shell-free prerequisite check — each binary name travels as a data argv. */
export function checkPrerequisites(names: string[]): string | null {
  for (const bin of names) {
    const r = spawnSync("which", [bin], { stdio: "ignore", timeout: 5000 });
    if (r.error || r.status !== 0) return bin;
  }
  return null;
}

/** Load a skill by name for a user: config, SKILL.md, bounded context. */
export function loadSkill(skillName: string, userId: string): SkillLoadResult {
  if (!SKILL_IDENTIFIER_RE.test(skillName)) {
    return { ok: false, error: { code: "invalid_identifier", message: `Invalid skill identifier "${skillName}"` } };
  }
  const dir = resolveSkillDir(skillName);
  if (!dir) {
    return { ok: false, error: { code: "not_found", message: `Skill "${skillName}" not found or has no skill.json` } };
  }
  const configPath = normalizeUnderRoot(join(dir, "skill.json"), abtarsHome());
  if (!configPath) {
    return { ok: false, error: { code: "not_found", message: `Skill "${skillName}" has an unsafe skill.json path` } };
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return { ok: false, error: { code: "not_found", message: `Skill "${skillName}" has no readable skill.json` } };
  }
  const parsed = parseSkillConfig(raw);
  if (!parsed.ok) return parsed;

  const skillMdPath = normalizeUnderRoot(join(dir, "SKILL.md"), abtarsHome());
  if (!skillMdPath || !existsSync(skillMdPath)) {
    return { ok: false, error: { code: "missing_skill_md", message: `Skill "${skillName}" has no SKILL.md` } };
  }
  let skillMd: string;
  try {
    skillMd = readFileSync(skillMdPath, "utf-8").trim();
  } catch {
    return { ok: false, error: { code: "missing_skill_md", message: `Skill "${skillName}" SKILL.md is not readable` } };
  }

  let contextPath: string | undefined;
  let context: string | undefined;
  if (parsed.config.contextPath) {
    const resolved = resolveContextPath(parsed.config, userId);
    if (!resolved) {
      return { ok: false, error: { code: "invalid_context_path", message: `Skill "${skillName}" contextPath escapes approved roots` } };
    }
    contextPath = resolved;
    try {
      if (existsSync(contextPath)) {
        const raw = readFileSync(contextPath, "utf-8").trim();
        context = raw.length > SKILL_CONTEXT_MAX_CHARS ? raw.slice(0, SKILL_CONTEXT_MAX_CHARS) : raw;
      }
      mkdirSync(dirname(contextPath), { recursive: true });
    } catch {
      return { ok: false, error: { code: "invalid_context_path", message: `Skill "${skillName}" contextPath is not usable` } };
    }
  }

  const missing = parsed.config.prerequisites ? checkPrerequisites(parsed.config.prerequisites) : null;
  if (missing) {
    return { ok: false, error: { code: "missing_prerequisite", message: `Cannot run ${skillName}: "${missing}" not found on PATH` } };
  }

  logInfo(TAG, `Loaded skill "${skillName}" (timeout=${parsed.config.timeout}s, context=${contextPath ?? "none"})`);
  return {
    ok: true,
    skill: {
      name: skillName,
      dir,
      config: parsed.config,
      skillMd,
      contextPath,
      context,
    },
  };
}

/** #1432: bootstrap block = SKILL.md + bounded CONTEXT.md + user message. */
export function buildBootstrap(skillName: string, skillMd: string, context: string | undefined, message: string): string {
  const parts: string[] = [];
  parts.push(`[INTERACTIVE SKILL: ${skillName}]\n${skillMd}`);
  if (context) parts.push(`[SKILL CONTEXT]\n${context}`);
  parts.push(`[USER MESSAGE]\n${message}`);
  return parts.join("\n\n");
}

/** List all launchable interactive skills (strict parse). */
export function listRunnableSkillsStrict(): Array<{ name: string; description: string; interactive: boolean }> {
  const results: Array<{ name: string; description: string; interactive: boolean }> = [];
  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSafe(root)) {
      const dir = join(root, entry);
      if (!existsSync(join(dir, "skill.json"))) continue;
      try {
        const parsed = parseSkillConfig(readFileSync(join(dir, "skill.json"), "utf-8"));
        if (parsed.ok) {
          results.push({ name: entry, description: parsed.config.description ?? "", interactive: parsed.config.interactive });
        }
      } catch { /* unreadable skill is catalog-silent */ }
    }
  }
  return results;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

/** Approved roots for containment checks (realpathed). */
export function approvedRoots(): string[] {
  const roots = [abtarsHome(), abtarsRoot()];
  return roots.map(safeRealpath).filter((r): r is string => r !== null);
}
