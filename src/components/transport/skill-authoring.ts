/**
 * skill-authoring.ts — skill_create tool (#381, #614).
 * Agent persists procedural knowledge as skills under ~/.abtars/skills/self/.
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
const MIN_BYTES = 100;
const MAX_BYTES = 50_000;
const MAX_TAGS = 5;

function skillsDir(): string { return join(abtarsHome(), "skills"); }
function selfDir(): string { return join(skillsDir(), "self"); }
function auditLogPath(): string { return join(abtarsHome(), "logs", "skill-authoring.log"); }

function audit(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  try {
    const dir = join(abtarsHome(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(auditLogPath(), line);
  } catch (err) { logAndSwallow(TAG, "audit write", err); }
}

function validate(name: string, description: string, content: string): string | null {
  if (!NAME_RE.test(name)) return `Invalid name "${name}". Must be 3-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`;
  const desc = description.trim();
  if (desc.length < 1 || desc.length > 120) return `Description must be 1-120 chars (got ${desc.length}).`;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes < MIN_BYTES) return `Content too short (${bytes} bytes, minimum ${MIN_BYTES}). Write a useful skill, not a one-liner.`;
  if (bytes > MAX_BYTES) return `Content too large (${bytes} bytes, maximum ${MAX_BYTES}). Split into a skill + references/ files.`;
  const path = join(selfDir(), name, "SKILL.md");
  if (existsSync(path)) return `Skill "${name}" already exists. Use skill_update to modify it.`;
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
      description: { type: "string", description: "One-line description, max 120 chars. Shown in skills_catalog." },
      content: { type: "string", description: "Skill body in Markdown. Starts with # <Title>. No frontmatter — the tool writes it." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization (max 5). E.g. ['tools', 'browser', 'debugging']." },
    },
    required: ["name", "description", "content"],
  },
  async execute(args) {
    const { name, description, content, tags } = args as unknown as { name: string; description: string; content: string; tags?: string[] };
    const error = validate(name, description, content);
    if (error) {
      audit(`skill_create name=${name} bytes=${content.length} ok=false error="${error}"`);
      return JSON.stringify({ error });
    }

    const tagList = (tags ?? []).slice(0, MAX_TAGS).map(t => t.toLowerCase().trim()).filter(Boolean);
    const tagsLine = tagList.length > 0 ? `tags: [${tagList.join(", ")}]\n` : "";
    const frontmatter = `---\nname: ${name}\ndescription: ${description.trim()}\n${tagsLine}---\n\n`;
    const fullContent = frontmatter + content;
    const dir = join(selfDir(), name);
    const filePath = join(dir, "SKILL.md");
    const tmpPath = filePath + ".tmp";

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmpPath, fullContent, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit(`skill_create name=${name} bytes=${content.length} ok=false error="write failed: ${msg}"`);
      return JSON.stringify({ error: `Write failed: ${msg}` });
    }

    audit(`skill_create name=${name} tags=[${tagList.join(",")}] bytes=${content.length} ok=true`);
    logInfo(TAG, `Created skill: self/${name} (${content.length} bytes)`);
    return JSON.stringify({ ok: true, path: filePath, message: `Skill "${name}" created in self/. Available in skills_catalog after /skill reload.` });
  },
};
