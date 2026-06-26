/**
 * skill-session.ts — Launch and manage skill sessions (#1141).
 *
 * Skills with skill.json are launchable into dedicated T-sessions.
 * Entry points: /skill run, model dispatch_skill tool, task with skill field.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { abtarsHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "skill-session";

export interface SkillConfig {
  agent?: string;
  interactive?: boolean;
  contextPath?: string;
  description?: string;
  memory?: boolean;
  tools?: string[];
  timeout?: number;
  prerequisites?: string[];
}

interface ActiveSkillSession {
  skillName: string;
  sessionId: string;
  userId: string;
  chatId: string;
  startedAt: number;
  timeout: number;
}

/** Active skill sessions keyed by chatId */
const activeSessions = new Map<string, ActiveSkillSession>();

const SKILL_SUBDIRS = ["self", "custom", "downloaded", "core"];

/** Resolve a skill directory by name — searches self → custom → downloaded → core. */
function resolveSkillDir(name: string): string | null {
  const base = join(abtarsHome(), "skills");
  for (const sub of SKILL_SUBDIRS) {
    const dir = join(base, sub, name);
    if (existsSync(join(dir, "skill.json"))) return dir;
  }
  // Also check core/skills in the app bundle
  const bundleDir = join(abtarsHome(), "app", "bundle", "core", "skills", name);
  if (existsSync(join(bundleDir, "skill.json"))) return bundleDir;
  return null;
}

/** Read and parse skill.json from a skill directory. */
function readSkillConfig(dir: string): SkillConfig | null {
  try {
    return JSON.parse(readFileSync(join(dir, "skill.json"), "utf-8")) as SkillConfig;
  } catch { return null; }
}

/** Check prerequisites (which <bin>). Returns first missing binary or null if all OK. */
function checkPrerequisites(config: SkillConfig): string | null {
  for (const bin of config.prerequisites ?? []) {
    try { execSync(`which ${bin}`, { stdio: "ignore" }); }
    catch { return bin; }
  }
  return null;
}

/** Launch a skill session. Returns error message or null on success. */
export async function launchSkill(skillName: string, userId: string, chatId: string, message?: string): Promise<string | null> {
  const dir = resolveSkillDir(skillName);
  if (!dir) return `Skill "${skillName}" not found or has no skill.json`;

  const config = readSkillConfig(dir);
  if (!config) return `Failed to read skill.json for "${skillName}"`;

  // Check prerequisites
  const missing = checkPrerequisites(config);
  if (missing) return `Cannot run ${skillName}: "${missing}" not found on PATH`;

  // End existing skill session for this chat if any
  if (activeSessions.has(chatId)) {
    await endSkillSession(chatId);
  }

  // Read SKILL.md
  const skillMdPath = join(dir, "SKILL.md");
  const skillMd = existsSync(skillMdPath) ? readFileSync(skillMdPath, "utf-8").trim() : "";
  if (!skillMd) return `Skill "${skillName}" has no SKILL.md`;

  // Read CONTEXT.md (resolve ${userId} in contextPath)
  let context = "";
  if (config.contextPath) {
    const ctxPath = join(abtarsHome(), config.contextPath.replace("${userId}", userId));
    if (existsSync(ctxPath)) {
      const raw = readFileSync(ctxPath, "utf-8").trim();
      context = raw.length > 30000 ? raw.slice(0, 30000) : raw;
    }
    // Ensure directory exists for model to write later
    mkdirSync(join(ctxPath, ".."), { recursive: true });
  }

  // Build goal prompt
  const parts: string[] = [];
  parts.push(`[SKILL: ${skillName}]\n${skillMd}`);
  if (context) parts.push(`[SKILL CONTEXT — progress from previous sessions]\n${context}`);
  if (message) parts.push(`[USER MESSAGE]\n${message}`);
  const goal = parts.join("\n\n");

  // Dispatch via Spin
  const { spin } = await import("./spin.js");
  const timeout = (config.timeout ?? 1800) * 1000;

  const { cardId } = spin.dispatch({
    type: "T",
    agent: (config.agent ?? "professor") as any,
    goal,
    title: `Skill: ${skillName}`,
    source: "task",
    timeoutMs: timeout,
    chatId,
  });

  // Track active session
  const sessionId = `skill_${skillName}_${Date.now()}`;
  activeSessions.set(chatId, {
    skillName,
    sessionId,
    userId,
    chatId,
    startedAt: Date.now(),
    timeout: config.timeout ?? 1800,
  });

  logInfo(TAG, `Launched skill "${skillName}" for ${userId} (chat ${chatId}, card ${cardId}, interactive=${config.interactive ?? false})`);
  return null;
}

/** End an active skill session for a chatId. */
export async function endSkillSession(chatId: string): Promise<boolean> {
  const session = activeSessions.get(chatId);
  if (!session) return false;
  activeSessions.delete(chatId);
  logInfo(TAG, `Ended skill "${session.skillName}" for ${session.userId} (${Math.round((Date.now() - session.startedAt) / 1000)}s)`);
  return true;
}

/** Get active skill session for a chatId (used by pipeline routing). */
export function getActiveSkillSession(chatId: string): ActiveSkillSession | undefined {
  const session = activeSessions.get(chatId);
  if (!session) return undefined;
  // Check timeout
  if (Date.now() - session.startedAt > session.timeout * 1000) {
    activeSessions.delete(chatId);
    logWarn(TAG, `Skill "${session.skillName}" timed out for ${session.userId}`);
    return undefined;
  }
  return session;
}

/** List all launchable skills (have skill.json). */
export function listRunnableSkills(): Array<{ name: string; description: string; interactive: boolean }> {
  const base = join(abtarsHome(), "skills");
  const results: Array<{ name: string; description: string; interactive: boolean }> = [];
  for (const sub of SKILL_SUBDIRS) {
    const subDir = join(base, sub);
    if (!existsSync(subDir)) continue;
    try {
      for (const entry of readdirSync(subDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(subDir, entry.name);
        if (!existsSync(join(dir, "skill.json"))) continue;
        const config = readSkillConfig(dir);
        if (config) results.push({ name: entry.name, description: config.description ?? "", interactive: config.interactive ?? false });
      }
    } catch {}
  }
  return results;
}
