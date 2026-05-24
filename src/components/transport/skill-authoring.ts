/**
 * skill-authoring.ts — skill_create tool (#381).
 * Agent persists procedural knowledge as skills.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { scanForInjection } from "abmind";
import { abtarsHome } from "../../paths.js";
import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { ToolDefinition } from "./tool-registry.js";

const TAG = "skill-authoring";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const CATEGORIES = ["coding", "tools", "memory", "ops"] as const;
const MIN_BYTES = 100;
const MAX_BYTES = 50_000;

function skillsDir(): string { return join(abtarsHome(), "skills"); }
function auditLogPath(): string { return join(abtarsHome(), "logs", "skill-authoring.log"); }

function audit(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  try {
    const dir = join(abtarsHome(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(auditLogPath(), line);
  } catch (err) { logAndSwallow(TAG, "audit write", err); }
}

function validate(name: string, category: string, description: string, content: string): string | null {
  if (!NAME_RE.test(name)) return `Invalid name "${name}". Must be 3-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`;
  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) return `Invalid category "${category}". Must be one of: ${CATEGORIES.join(", ")}`;
  const desc = description.trim();
  if (desc.length < 1 || desc.length > 120) return `Description must be 1-120 chars (got ${desc.length}).`;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes < MIN_BYTES) return `Content too short (${bytes} bytes, minimum ${MIN_BYTES}). Write a useful skill, not a one-liner.`;
  if (bytes > MAX_BYTES) return `Content too large (${bytes} bytes, maximum ${MAX_BYTES}). Split into a skill + references/ files.`;
  const path = join(skillsDir(), category, name, "SKILL.md");
  if (existsSync(path)) return `Skill "${name}" already exists at ${path}. Pick a different name.`;
  const scan = scanForInjection(content);
  if (!scan.safe) return `Content blocked by injection scanner: ${scan.flags[0]?.category ?? "unknown"} (score=${scan.score}). Rephrase the content.`;
  return null;
}

export const skillCreateTool: ToolDefinition = {
  name: "skill_create",
  description: "Persist a new procedural skill to disk. Use when you've solved a novel task, discovered a workflow, or received a correction worth remembering as a repeatable recipe. Skills become available in future sessions via the skills_catalog.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill identifier, kebab-case, e.g. 'fix-pnpm-workspace-drift'. 3-64 chars, [a-z0-9-]+." },
      category: { type: "string", enum: [...CATEGORIES], description: "Category: coding, tools, memory, or ops. When unsure, use 'tools'." },
      description: { type: "string", description: "One-line description, max 120 chars. Shown in skills_catalog." },
      content: { type: "string", description: "Skill body in Markdown. Starts with # <Title>. No frontmatter — the tool writes it." },
    },
    required: ["name", "category", "description", "content"],
  },
  async execute(args) {
    const { name, category, description, content } = args as { name: string; category: string; description: string; content: string };
    const error = validate(name, category, description, content);
    if (error) {
      audit(`skill_create name=${name} category=${category} bytes=${content.length} ok=false error="${error}"`);
      return JSON.stringify({ error });
    }

    const frontmatter = `---\nname: ${name}\ndescription: ${description.trim()}\n---\n\n`;
    const fullContent = frontmatter + content;
    const dir = join(skillsDir(), category, name);
    const filePath = join(dir, "SKILL.md");
    const tmpPath = filePath + ".tmp";

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmpPath, fullContent, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit(`skill_create name=${name} category=${category} bytes=${content.length} ok=false error="write failed: ${msg}"`);
      return JSON.stringify({ error: `Write failed: ${msg}` });
    }

    audit(`skill_create name=${name} category=${category} bytes=${content.length} ok=true`);
    logInfo(TAG, `Created skill: ${category}/${name} (${content.length} bytes)`);
    return JSON.stringify({ ok: true, path: filePath, message: `Skill "${name}" created. It will appear in skills_catalog on the next heartbeat tick.` });
  },
};
