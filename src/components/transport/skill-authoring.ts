/**
 * skill-authoring.ts — skill lifecycle tools (#381, #613, #614).
 * Agent persists procedural knowledge as skills under ~/.abtars/skills/self/.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { abmind } from "../../utils/abmind-lazy.js";
import { abtarsHome } from "../../paths.js";
import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { setProvenance } from "../skill-stats.js";
import type { ToolDefinition } from "./tool-registry.js";

const TAG = "skill-authoring";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const MIN_BYTES = 100;
const MAX_BYTES = 50_000;
const MAX_TAGS = 5;

function skillsDir(): string { return join(abtarsHome(), "skills"); }
function selfDir(): string { return join(skillsDir(), "self"); }
function trashDir(): string { return join(skillsDir(), ".trash"); }
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
  const scan = abmind()?.scanForInjection(content);
  if (scan && !scan.safe) return `Content blocked by injection scanner: ${scan.flags[0]?.category ?? "unknown"} (score=${scan.score}). Rephrase the content.`;
  return null;
}

/** Parse YAML-like frontmatter from SKILL.md content. */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Parse array: [a, b, c]
    if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, body: match[2]! };
}

/** Serialize frontmatter fields back to YAML-like string. */
function serializeFrontmatter(meta: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length > 0) {
      lines.push(`${k}: [${v.join(", ")}]`);
    } else if (!Array.isArray(v)) {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---\n\n");
  return lines.join("\n");
}

/** Guard: skill must exist in self/ dir. Returns error string or null. */
function guardSelfSkill(name: string): string | null {
  if (!NAME_RE.test(name)) return `Invalid name "${name}".`;
  const path = join(selfDir(), name, "SKILL.md");
  if (!existsSync(path)) return `Skill "${name}" not found in self/.`;
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
      related: { type: "array", items: { type: "string" }, description: "Optional related skill names." },
    },
    required: ["name", "description", "content"],
  },
  async execute(args) {
    const { name, description, content, tags, related } = args as unknown as { name: string; description: string; content: string; tags?: string[]; related?: string[] };
    const error = validate(name, description, content);
    if (error) {
      audit(`skill_create name=${name} bytes=${content.length} ok=false error="${error}"`);
      return JSON.stringify({ error });
    }

    const tagList = (tags ?? []).slice(0, MAX_TAGS).map(t => t.toLowerCase().trim()).filter(Boolean);
    const relList = (related ?? []).filter(Boolean);
    const tagsLine = tagList.length > 0 ? `tags: [${tagList.join(", ")}]\n` : "";
    const relatedLine = relList.length > 0 ? `related: [${relList.join(", ")}]\n` : "";
    const frontmatter = `---\nname: ${name}\ndescription: ${description.trim()}\n${tagsLine}${relatedLine}---\n\n`;
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

    setProvenance(name, "agent");
    audit(`skill_create name=${name} tags=[${tagList.join(",")}] bytes=${content.length} ok=true`);
    logInfo(TAG, `Created skill: self/${name} (${content.length} bytes)`);
    return JSON.stringify({ ok: true, path: filePath, message: `Skill "${name}" created in self/. Available in skills_catalog after /skill reload.` });
  },
};

export const skillUpdateTool: ToolDefinition = {
  name: "skill_update",
  description: "Full rewrite of an existing skill's SKILL.md in self/. Preserves frontmatter fields (tags, related, description) when omitted by caller.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (must exist in self/)." },
      description: { type: "string", description: "New description (optional — keeps existing if omitted)." },
      content: { type: "string", description: "New skill body in Markdown (no frontmatter)." },
      tags: { type: "array", items: { type: "string" }, description: "New tags (optional — keeps existing if omitted)." },
      related: { type: "array", items: { type: "string" }, description: "New related skills (optional — keeps existing if omitted)." },
    },
    required: ["name", "content"],
  },
  async execute(args) {
    const { name, content, description, tags, related } = args as unknown as { name: string; content: string; description?: string; tags?: string[]; related?: string[] };
    const guard = guardSelfSkill(name);
    if (guard) { audit(`skill_update name=${name} ok=false error="${guard}"`); return JSON.stringify({ error: guard }); }

    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes < MIN_BYTES) return JSON.stringify({ error: `Content too short (${bytes} bytes, minimum ${MIN_BYTES}).` });
    if (bytes > MAX_BYTES) return JSON.stringify({ error: `Content too large (${bytes} bytes, maximum ${MAX_BYTES}).` });

    const scan = abmind()?.scanForInjection(content);
    if (scan && !scan.safe) return JSON.stringify({ error: `Content blocked by injection scanner: ${scan.flags[0]?.category ?? "unknown"}.` });

    const filePath = join(selfDir(), name, "SKILL.md");
    const existing = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(existing);

    // Merge: caller fields override, omitted fields preserved
    const merged: Record<string, unknown> = { ...meta, name };
    if (description !== undefined) merged["description"] = description.trim();
    if (tags !== undefined) merged["tags"] = tags.slice(0, MAX_TAGS).map(t => t.toLowerCase().trim()).filter(Boolean);
    if (related !== undefined) merged["related"] = related.filter(Boolean);

    const fullContent = serializeFrontmatter(merged) + content;
    const tmpPath = filePath + ".tmp";
    try {
      writeFileSync(tmpPath, fullContent, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit(`skill_update name=${name} ok=false error="write failed: ${msg}"`);
      return JSON.stringify({ error: `Write failed: ${msg}` });
    }

    audit(`skill_update name=${name} bytes=${bytes} ok=true`);
    logInfo(TAG, `Updated skill: self/${name} (${bytes} bytes)`);
    return JSON.stringify({ ok: true, path: filePath, message: `Skill "${name}" updated.` });
  },
};

export const skillPatchTool: ToolDefinition = {
  name: "skill_patch",
  description: "Targeted find-and-replace within a skill's SKILL.md in self/. old_string must match exactly once.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (must exist in self/)." },
      old_string: { type: "string", description: "Exact string to find (must match once)." },
      new_string: { type: "string", description: "Replacement string." },
    },
    required: ["name", "old_string", "new_string"],
  },
  async execute(args) {
    const { name, old_string, new_string } = args as unknown as { name: string; old_string: string; new_string: string };
    const guard = guardSelfSkill(name);
    if (guard) { audit(`skill_patch name=${name} ok=false error="${guard}"`); return JSON.stringify({ error: guard }); }

    const filePath = join(selfDir(), name, "SKILL.md");
    const existing = readFileSync(filePath, "utf-8");

    const count = existing.split(old_string).length - 1;
    if (count === 0) return JSON.stringify({ error: `old_string not found in skill "${name}".` });
    if (count > 1) return JSON.stringify({ error: `old_string matches ${count} times — must match exactly once.` });

    const patched = existing.replace(old_string, new_string);
    const scan = abmind()?.scanForInjection(patched);
    if (scan && !scan.safe) return JSON.stringify({ error: `Patched content blocked by injection scanner: ${scan.flags[0]?.category ?? "unknown"}.` });

    const tmpPath = filePath + ".tmp";
    try {
      writeFileSync(tmpPath, patched, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit(`skill_patch name=${name} ok=false error="write failed: ${msg}"`);
      return JSON.stringify({ error: `Write failed: ${msg}` });
    }

    audit(`skill_patch name=${name} ok=true`);
    logInfo(TAG, `Patched skill: self/${name}`);
    return JSON.stringify({ ok: true, path: filePath, message: `Skill "${name}" patched.` });
  },
};

export const skillRemoveTool: ToolDefinition = {
  name: "skill_remove",
  description: "Soft-delete a skill from self/ by moving it to .trash/ (recoverable for 7 days).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (must exist in self/)." },
    },
    required: ["name"],
  },
  async execute(args) {
    const { name } = args as unknown as { name: string };
    const guard = guardSelfSkill(name);
    if (guard) { audit(`skill_remove name=${name} ok=false error="${guard}"`); return JSON.stringify({ error: guard }); }

    const srcDir = join(selfDir(), name);
    const ts = Date.now();
    const destDir = join(trashDir(), `${name}-${ts}`);
    try {
      mkdirSync(trashDir(), { recursive: true });
      renameSync(srcDir, destDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit(`skill_remove name=${name} ok=false error="move failed: ${msg}"`);
      return JSON.stringify({ error: `Move failed: ${msg}` });
    }

    audit(`skill_remove name=${name} dest=${destDir} ok=true`);
    logInfo(TAG, `Removed skill: self/${name} → .trash/`);
    return JSON.stringify({ ok: true, message: `Skill "${name}" moved to .trash/. Will be pruned after 7 days.` });
  },
};
